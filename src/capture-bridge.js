"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const ffmpegPath = require("ffmpeg-static");
const { isBlockedHost, parseHttpUrl } = require("./policy");
const { resolvePublicPage } = require("./page-resolver");

const DEFAULT_BRIDGE_PORT = 48_731;
const ALLOWED_EXTENSION_ORIGINS = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;

function isAllowedOrigin(origin) {
  return ALLOWED_EXTENSION_ORIGINS.test(String(origin || ""));
}

function probeMedia(url, pageUrl) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-headers",
        `Referer: ${pageUrl}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n`,
        "-i",
        url
      ],
      { windowsHide: true }
    );
    const timeout = setTimeout(() => child.kill(), 12_000);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64_000) stderr += chunk.toString();
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ audioCodec: "", duration: "", url, videoCodec: "" });
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      const video = stderr.match(/Video:\s*([^,\s]+)/i);
      const audio = stderr.match(/Audio:\s*([^,\s]+)/i);
      const dimensions = stderr.match(/(\d{2,5})x(\d{2,5})/);
      const duration = stderr.match(/Duration:\s*([0-9:.]+)/i);
      resolve({
        audioCodec: audio?.[1]?.toLowerCase() || "",
        duration: duration?.[1] || "",
        height: Number(dimensions?.[2]) || 0,
        url,
        videoCodec: video?.[1]?.toLowerCase() || "",
        width: Number(dimensions?.[1]) || 0
      });
    });
  });
}

function json(response, status, body, origin = "") {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function startCaptureBridge(onCapture, port = DEFAULT_BRIDGE_PORT, getResolverOptions = () => ({})) {
  const commands = [];
  const mediaProxies = new Map();
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin || "";
    const proxyMatch = request.url?.match(
      /^\/media\/([a-f0-9-]+)\/(?:video\.mp4|audio\.m4a)$/i
    );

    if ((request.method === "GET" || request.method === "HEAD") && proxyMatch) {
      const proxy = mediaProxies.get(proxyMatch[1]);
      if (!proxy) {
        json(response, 404, { ok: false, message: "Media link expired." });
        return;
      }
      const headers = {
        Referer: proxy.pageUrl,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      };
      if (request.headers.range) headers.Range = request.headers.range;
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      fetch(proxy.url, {
        headers,
        method: request.method,
        signal: controller.signal
      }).then((upstream) => {
        const forwarded = {};
        for (const name of [
          "accept-ranges",
          "content-length",
          "content-range",
          "content-type",
          "etag",
          "last-modified"
        ]) {
          const value = upstream.headers.get(name);
          if (value) forwarded[name] = value;
        }
        response.writeHead(upstream.status, forwarded);
        if (request.method === "HEAD" || !upstream.body) {
          response.end();
          return;
        }
        const stream = Readable.fromWeb(upstream.body);
        stream.on("error", (error) => {
          if (error?.name !== "AbortError" && !response.destroyed) {
            response.destroy(error);
          }
        });
        response.on("error", () => stream.destroy());
        stream.pipe(response);
      }).catch(() => {
        if (!response.headersSent) {
          json(response, 502, { ok: false, message: "Unable to stream resolved media." });
        } else {
          response.destroy();
        }
      });
      return;
    }

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) {
        json(response, 403, { ok: false, message: "Extension origin required." });
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Max-Age": "600",
        Vary: "Origin"
      });
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/status") {
      json(response, 200, { ok: true, service: "Media Scout capture bridge" }, origin);
      return;
    }

    if (request.method === "GET" && request.url === "/commands") {
      if (!isAllowedOrigin(origin)) {
        json(response, 403, { ok: false, message: "Extension origin required." });
        return;
      }
      json(response, 200, { commands: commands.splice(0, commands.length), ok: true }, origin);
      return;
    }

    if (
      request.method !== "POST" ||
      request.url !== "/resolve"
    ) {
      json(response, 404, { ok: false, message: "Not found." }, origin);
      return;
    }

    if (!isAllowedOrigin(origin)) {
      json(response, 403, { ok: false, message: "Extension origin required." });
      return;
    }

    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32_768) request.destroy();
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(raw);
        const page = parseHttpUrl(payload.pageUrl);
        const mediaHint = parseHttpUrl(payload.mediaUrl);
        const isDouyinPage =
          page &&
          (page.hostname === "v.douyin.com" ||
            page.hostname === "douyin.com" ||
            page.hostname === "www.douyin.com");
        const usableDouyinHint =
          isDouyinPage &&
          mediaHint &&
          !isBlockedHost(mediaHint.hostname) &&
          !["blob:", "data:"].includes(mediaHint.protocol);
        let selectedDouyinMedia = null;
        if (usableDouyinHint) {
          const candidates = [
            mediaHint.href,
            ...(Array.isArray(payload.mediaCandidates) ? payload.mediaCandidates : [])
          ]
            .map((url) => parseHttpUrl(url))
            .filter(
              (url) =>
                url &&
                !isBlockedHost(url.hostname) &&
                !["blob:", "data:"].includes(url.protocol)
            )
            .map((url) => url.href)
            .filter((url, index, all) => index === all.indexOf(url))
            .slice(0, 16);
          const probes = await Promise.all(
            candidates.map((url) => probeMedia(url, page.href))
          );
          selectedDouyinMedia =
            probes.find(
              (probe) =>
                /^(?:h264|avc)/i.test(probe.videoCodec) && probe.audioCodec
            ) ||
            probes.find((probe) => probe.videoCodec && probe.audioCodec) ||
            probes.find((probe) => /^(?:h264|avc)/i.test(probe.videoCodec)) ||
            probes.find((probe) => probe.videoCodec) ||
            null;
          const separateAudio =
            selectedDouyinMedia && !selectedDouyinMedia.audioCodec
              ? probes.find((probe) => !probe.videoCodec && probe.audioCodec)
              : null;
          if (selectedDouyinMedia && separateAudio) {
            selectedDouyinMedia.audioSourceUrl = separateAudio.url;
            selectedDouyinMedia.audioCodec = separateAudio.audioCodec;
          }
        }
        let resolverOptions;
        let resolved;
        try {
          resolverOptions = usableDouyinHint
            ? {}
            : await getResolverOptions(payload.pageUrl);
          resolved = usableDouyinHint
            ? {
              analysis: selectedDouyinMedia,
              candidates: selectedDouyinMedia ? [selectedDouyinMedia.url] : [],
              ok: Boolean(selectedDouyinMedia),
              pageUrl: page.href,
              thumbnail: String(payload.thumbnail || ""),
              title: String(payload.title || ""),
              reason: selectedDouyinMedia
                ? ""
                : "Douyin exposed audio-only or unreadable media."
              }
            : await resolvePublicPage(payload.pageUrl, resolverOptions);
        } finally {
          resolverOptions?.dispose?.();
        }
        if (!resolved.ok) {
          json(response, 422, resolved, origin);
          return;
        }
        for (const url of resolved.candidates.slice(0, 1)) {
          const parsed = parseHttpUrl(url);
          if (!parsed) continue;
          let deliveredUrl = parsed.href;
          let deliveredVariants = resolved.variants || [];
          const resolvedPageHost = new URL(resolved.pageUrl).hostname;
          if (
            resolvedPageHost.endsWith("bilibili.com") ||
            resolvedPageHost.endsWith("douyin.com") ||
            resolvedPageHost.endsWith("youtube.com") ||
            Boolean(resolved.analysis?.audioSourceUrl)
          ) {
            const sourceVariants = resolved.variants?.length
              ? resolved.variants
              : [{ label: "Best available", size: 0, url: parsed.href }];
            deliveredVariants = sourceVariants.map((variant) => {
              const token = crypto.randomUUID();
              mediaProxies.set(token, { pageUrl: resolved.pageUrl, url: variant.url });
              return {
                ...variant,
                url: `http://127.0.0.1:${server.address().port}/media/${token}/video.mp4`
              };
            });
            deliveredUrl = deliveredVariants[0]?.url || deliveredUrl;
            if (resolved.analysis?.audioSourceUrl) {
              const audioToken = crypto.randomUUID();
              mediaProxies.set(audioToken, {
                pageUrl: resolved.pageUrl,
                url: resolved.analysis.audioSourceUrl
              });
              resolved.analysis.audioUrl =
                `http://127.0.0.1:${server.address().port}/media/${audioToken}/audio.m4a`;
              delete resolved.analysis.audioSourceUrl;
            }
          }
          onCapture({
            allowed: true,
            analysis: resolved.analysis || null,
            detectedAt: new Date().toISOString(),
            extension: ".mp4",
            hostname: parsed.hostname,
            mime: "video/mp4",
            pageHost: new URL(resolved.pageUrl).hostname,
            pageUrl: resolved.pageUrl,
            size: resolved.candidateSizes?.[parsed.href] || 0,
            source: "Public page resolver",
            thumbnail: resolved.thumbnail || "",
            title: resolved.title || "",
            variants: deliveredVariants,
            url: deliveredUrl
          });
        }
        json(response, 202, { count: resolved.candidates.length, ok: true }, origin);
      } catch {
        json(response, 400, { ok: false, message: "Invalid capture payload." }, origin);
      }
    });
  });

  server.enqueueCommand = (command) => {
    commands.push(command);
    if (commands.length > 30) commands.splice(0, commands.length - 30);
  };
  server.listen(port, "127.0.0.1");
  return server;
}

module.exports = {
  ALLOWED_EXTENSION_ORIGINS,
  DEFAULT_BRIDGE_PORT,
  isAllowedOrigin,
  startCaptureBridge
};
