"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { unpackedBinaryPath } = require("./binary-path");
const ffmpegPath = unpackedBinaryPath(require("ffmpeg-static"));
const { classifyMedia, parseHttpUrl } = require("./policy");
const { resolvePublicPage } = require("./page-resolver");
const { decodePlaylist, decodeSegment } = require("./reanime-resolver");

const DEFAULT_BRIDGE_PORT = 48_731;
const ALLOWED_EXTENSION_ORIGINS =
  /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;
const PROXY_TTL_MS = 30 * 60 * 1000;
const MAX_MEDIA_PROXIES = 5_000;
const MAX_CAPTURE_PAYLOAD = 1024 * 1024;

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
        url,
      ],
      { windowsHide: true },
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
        width: Number(dimensions?.[1]) || 0,
      });
    });
  });
}

function json(response, status, body, origin = "") {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function subtitleTimestamp(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})[.,](\d+)$/);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${match[4].padEnd(3, "0").slice(0, 3)}`;
}

function subtitleToVtt(source, format = "") {
  if (/^webvtt/i.test(source.trim())) return source;
  if (format === "ass" || /^\s*\[Script Info\]/i.test(source)) {
    const cues = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const fields = line.slice(9).split(",");
      if (fields.length < 10) continue;
      const start = subtitleTimestamp(fields[1]);
      const end = subtitleTimestamp(fields[2]);
      const text = fields
        .slice(9)
        .join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/gi, "\n")
        .replace(/\\h/gi, " ")
        .trim();
      if (text) cues.push(`${start} --> ${end}\n${text}`);
    }
    return `WEBVTT\n\n${cues.join("\n\n")}\n`;
  }
  return `WEBVTT\n\n${source.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

function startCaptureBridge(
  onCapture,
  port = DEFAULT_BRIDGE_PORT,
  getResolverOptions = () => ({}),
  bridgeOptions = {},
) {
  const commands = [];
  const mediaProxies = new Map();
  const sockets = new Set();
  const proxyTtlMs = bridgeOptions.proxyTtlMs || PROXY_TTL_MS;
  const probeMediaImpl = bridgeOptions.probeMedia || probeMedia;
  const resolvePublicPageImpl =
    bridgeOptions.resolvePublicPage || resolvePublicPage;
  const pairingCode = String(bridgeOptions.pairingCode || "");
  let pairedOrigin = "";
  const extensionAuthorized = (origin, request) => {
    if (!isAllowedOrigin(origin)) return false;
    if (!pairedOrigin && !pairingCode) pairedOrigin = origin;
    if (
      !pairedOrigin &&
      pairingCode &&
      request?.headers["x-media-scout-pairing"] === pairingCode
    ) {
      pairedOrigin = origin;
    }
    return origin === pairedOrigin;
  };
  const pruneMediaProxies = () => {
    const cutoff = Date.now() - proxyTtlMs;
    for (const [token, proxy] of mediaProxies) {
      if (proxy.createdAt < cutoff) mediaProxies.delete(token);
    }
    while (mediaProxies.size > MAX_MEDIA_PROXIES) {
      mediaProxies.delete(mediaProxies.keys().next().value);
    }
  };
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin || "";
    pruneMediaProxies();
    const proxyMatch = request.url?.match(
      /^\/(?:media|resource)\/([a-f0-9-]+)\/[^/?]+$/i,
    );
    const manifestMatch = request.url?.match(
      /^\/manifest\/([a-f0-9-]+)\/index\.m3u8$/i,
    );
    const subtitleMatch = request.url?.match(
      /^\/subtitle\/([a-f0-9-]+)\/subtitle\.vtt$/i,
    );

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      subtitleMatch
    ) {
      const subtitle = mediaProxies.get(subtitleMatch[1]);
      if (!subtitle?.subtitleUrl) {
        json(response, 404, { ok: false, message: "Subtitle expired." });
        return;
      }
      fetch(subtitle.subtitleUrl, {
        headers: {
          Origin: "https://flixcloud.cc",
          Referer: "https://flixcloud.cc/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
        },
        method: request.method,
      })
        .then(async (upstream) => {
          if (!upstream.ok) {
            throw new Error(`Subtitle returned HTTP ${upstream.status}.`);
          }
          const vtt =
            request.method === "HEAD"
              ? ""
              : subtitleToVtt(await upstream.text(), subtitle.format);
          response.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Content-Type": "text/vtt; charset=utf-8",
          });
          response.end(vtt);
        })
        .catch(() => {
          if (!response.headersSent) {
            json(response, 502, {
              ok: false,
              message: "Unable to fetch the subtitle.",
            });
          }
        });
      return;
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      manifestMatch
    ) {
      const manifest = mediaProxies.get(manifestMatch[1]);
      if (!manifest?.manifestText && !manifest?.manifestUrl) {
        json(response, 404, { ok: false, message: "Manifest expired." });
        return;
      }
      const sendManifest = (manifestText) => {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/vnd.apple.mpegurl",
        });
        response.end(request.method === "HEAD" ? "" : manifestText);
      };
      if (manifest.manifestText) {
        sendManifest(manifest.manifestText);
        return;
      }
      fetch(manifest.manifestUrl, {
        headers: {
          Origin: "https://flixcloud.cc",
          Referer: "https://flixcloud.cc/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/136.0.0.0 Safari/537.36",
        },
        method: request.method,
      })
        .then(async (upstream) => {
          if (!upstream.ok) {
            throw new Error(`Playlist returned HTTP ${upstream.status}.`);
          }
          if (request.method === "HEAD") {
            sendManifest("");
            return;
          }
          const decoded = decodePlaylist(
            await upstream.text(),
            manifest.playlistKey,
          );
          const localizePlaylist = (value) => {
            const absolute = new URL(value, manifest.manifestUrl).href;
            const token = crypto.randomUUID();
            if (/\.m3u8(?:$|[?#])/i.test(absolute)) {
              mediaProxies.set(token, {
                createdAt: Date.now(),
                manifestUrl: absolute,
                playlistKey: manifest.playlistKey,
              });
              return (
                `http://127.0.0.1:${server.address().port}` +
                `/manifest/${token}/index.m3u8`
              );
            }
            mediaProxies.set(token, {
              createdAt: Date.now(),
              decodeSegment: true,
              pageUrl: "https://flixcloud.cc/",
              url: absolute,
            });
            const filename =
              new URL(absolute).pathname.split("/").pop() || "resource.bin";
            return (
              `http://127.0.0.1:${server.address().port}` +
              `/resource/${token}/${encodeURIComponent(filename)}`
            );
          };
          const rewritten = decoded
            .replace(
              /URI="([^"]+)"/g,
              (_match, value) => `URI="${localizePlaylist(value)}"`,
            )
            .split(/\r?\n/)
            .map((line) =>
              line && !line.startsWith("#") ? localizePlaylist(line) : line,
            )
            .join("\n");
          sendManifest(rewritten);
        })
        .catch((error) => {
          bridgeOptions.log?.("error", "flixcloud-manifest-proxy-failed", {
            message: error?.message || String(error),
          });
          if (!response.headersSent) {
            json(response, 502, {
              ok: false,
              message: "Unable to decode the FlixCloud playlist.",
            });
          }
        });
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && proxyMatch) {
      const proxy = mediaProxies.get(proxyMatch[1]);
      if (!proxy || proxy.createdAt < Date.now() - proxyTtlMs) {
        if (proxy) mediaProxies.delete(proxyMatch[1]);
        json(response, 404, { ok: false, message: "Media link expired." });
        return;
      }
      const headers = {
        Referer: proxy.pageUrl,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      };
      if (proxy.pageUrl === "https://flixcloud.cc/") {
        headers.Origin = "https://flixcloud.cc";
      }
      if (request.headers.range) headers.Range = request.headers.range;
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      fetch(proxy.url, {
        headers,
        method: request.method,
        signal: controller.signal,
      })
        .then(async (upstream) => {
          if (proxy.decodeSegment && request.method !== "HEAD") {
            if (!upstream.ok) {
              throw new Error(`Segment returned HTTP ${upstream.status}.`);
            }
            const decoded = decodeSegment(await upstream.arrayBuffer());
            response.writeHead(upstream.status, {
              "Cache-Control": "no-store",
              "Content-Length": decoded.length,
              "Content-Type": "application/octet-stream",
            });
            response.end(decoded);
            return;
          }
          const forwarded = {};
          for (const name of [
            "accept-ranges",
            "content-length",
            "content-range",
            "content-type",
            "etag",
            "last-modified",
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
        })
        .catch(() => {
          if (!response.headersSent) {
            json(response, 502, {
              ok: false,
              message: "Unable to stream resolved media.",
            });
          } else {
            response.destroy();
          }
        });
      return;
    }

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) {
        json(response, 403, {
          ok: false,
          message: "Extension origin required.",
        });
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "content-type,x-media-scout-pairing",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/status") {
      extensionAuthorized(origin, request);
      json(
        response,
        200,
        {
          ok: true,
          paired: Boolean(pairedOrigin && pairedOrigin === origin),
          pairingRequired: Boolean(pairingCode),
          service: "Media Scout capture bridge",
        },
        origin,
      );
      return;
    }

    if (request.method === "POST" && request.url === "/pair") {
      if (!extensionAuthorized(origin, request)) {
        json(
          response,
          403,
          { ok: false, message: "Pairing code is incorrect." },
          origin,
        );
        return;
      }
      json(response, 200, { ok: true, paired: true }, origin);
      return;
    }

    if (request.method === "GET" && request.url === "/commands") {
      if (!extensionAuthorized(origin, request)) {
        json(response, 403, {
          ok: false,
          message: "Extension origin required.",
        });
        return;
      }
      json(
        response,
        200,
        { commands: commands.splice(0, commands.length), ok: true },
        origin,
      );
      return;
    }

    if (request.method !== "POST" || request.url !== "/resolve") {
      json(response, 404, { ok: false, message: "Not found." }, origin);
      return;
    }

    if (!extensionAuthorized(origin, request)) {
      json(response, 403, { ok: false, message: "Extension origin required." });
      return;
    }

    let raw = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_CAPTURE_PAYLOAD) {
        raw = "";
        tooLarge = true;
      }
    });
    request.on("end", async () => {
      try {
        if (tooLarge) {
          json(
            response,
            413,
            { ok: false, message: "Capture payload is too large." },
            origin,
          );
          return;
        }
        const payload = JSON.parse(raw);
        bridgeOptions.log?.("info", "bridge-resolve-received", {
          hasManifest: /^\s*#EXTM3U/i.test(String(payload.manifestText || "")),
          mediaUrl: String(payload.mediaUrl || ""),
          pageUrl: String(payload.pageUrl || ""),
        });
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
          !["blob:", "data:"].includes(mediaHint.protocol);
        const isReanimePage =
          page && /(?:^|\.)reanime\.to$/i.test(page.hostname);
        const usableCapturedHint =
          usableDouyinHint &&
          mediaHint &&
          !["blob:", "data:"].includes(mediaHint.protocol);
        let selectedCapturedMedia = null;
        if (usableCapturedHint) {
          const candidates = [
            mediaHint.href,
            ...(Array.isArray(payload.mediaCandidates)
              ? payload.mediaCandidates
              : []),
          ]
            .map((url) => parseHttpUrl(url))
            .filter((url) => url && !["blob:", "data:"].includes(url.protocol))
            .map((url) => url.href)
            .filter((url, index, all) => index === all.indexOf(url))
            .slice(0, 16);
          const probes = await Promise.all(
            candidates.map((url) => probeMediaImpl(url, page.href)),
          );
          selectedCapturedMedia =
            probes.find(
              (probe) =>
                /^(?:h264|avc)/i.test(probe.videoCodec) && probe.audioCodec,
            ) ||
            probes.find((probe) => probe.videoCodec && probe.audioCodec) ||
            probes.find((probe) => /^(?:h264|avc)/i.test(probe.videoCodec)) ||
            probes.find((probe) => probe.videoCodec) ||
            null;
          if (!selectedCapturedMedia && isReanimePage) {
            const hlsUrl = candidates.find((url) => classifyMedia(url).isHls);
            if (hlsUrl) {
              selectedCapturedMedia = {
                audioCodec: "",
                duration: "",
                url: hlsUrl,
                videoCodec: "",
              };
            }
          }
          const separateAudio =
            selectedCapturedMedia && !selectedCapturedMedia.audioCodec
              ? probes.find((probe) => !probe.videoCodec && probe.audioCodec)
              : null;
          if (selectedCapturedMedia && separateAudio) {
            selectedCapturedMedia.audioSourceUrl = separateAudio.url;
            selectedCapturedMedia.audioCodec = separateAudio.audioCodec;
          }
        }
        let resolverOptions;
        let resolved;
        try {
          resolverOptions = usableCapturedHint
            ? {}
            : await getResolverOptions(payload.pageUrl);
          resolved = usableCapturedHint
            ? {
                analysis: selectedCapturedMedia,
                candidateTypes:
                  selectedCapturedMedia &&
                  /\.m3u8(?:$|[?#])/i.test(selectedCapturedMedia.url)
                    ? {
                        [selectedCapturedMedia.url]:
                          "application/vnd.apple.mpegurl",
                      }
                    : {},
                candidates: selectedCapturedMedia
                  ? [selectedCapturedMedia.url]
                  : [],
                ok: Boolean(selectedCapturedMedia),
                pageUrl: page.href,
                thumbnail: String(payload.thumbnail || ""),
                title: String(payload.title || ""),
                reason: selectedCapturedMedia
                  ? ""
                  : isReanimePage
                    ? "FlixCloud exposed no readable HLS media."
                    : "Douyin exposed audio-only or unreadable media.",
              }
            : await resolvePublicPageImpl(payload.pageUrl, resolverOptions);
          if (
            resolved.ok &&
            isReanimePage &&
            selectedCapturedMedia &&
            /^\s*#EXTM3U/i.test(String(payload.manifestText || ""))
          ) {
            const sourceUrl = selectedCapturedMedia.url;
            const absoluteManifest = String(payload.manifestText)
              .replace(
                /URI="([^"]+)"/g,
                (_match, value) => `URI="${new URL(value, sourceUrl).href}"`,
              )
              .split(/\r?\n/)
              .map((line) =>
                line && !line.startsWith("#")
                  ? new URL(line, sourceUrl).href
                  : line,
              )
              .join("\n");
            const token = crypto.randomUUID();
            mediaProxies.set(token, {
              createdAt: Date.now(),
              manifestText: absoluteManifest,
            });
            const localManifest =
              `http://127.0.0.1:${server.address().port}` +
              `/manifest/${token}/index.m3u8`;
            resolved.candidates = [localManifest];
            resolved.candidateTypes = {
              [localManifest]: "application/vnd.apple.mpegurl",
            };
          }
        } finally {
          resolverOptions?.dispose?.();
        }
        if (!resolved.ok) {
          json(response, 422, resolved, origin);
          return;
        }
        if (
          resolved.provider === "reanime" &&
          resolved.playlistKey &&
          resolved.candidates[0]
        ) {
          const token = crypto.randomUUID();
          mediaProxies.set(token, {
            createdAt: Date.now(),
            manifestUrl: resolved.candidates[0],
            playlistKey: resolved.playlistKey,
          });
          const localManifest =
            `http://127.0.0.1:${server.address().port}` +
            `/manifest/${token}/index.m3u8`;
          resolved.candidates = [localManifest];
          resolved.candidateTypes = {
            [localManifest]: "application/vnd.apple.mpegurl",
          };
          resolved.subtitles = (resolved.subtitles || []).map((subtitle) => {
            const subtitleToken = crypto.randomUUID();
            mediaProxies.set(subtitleToken, {
              createdAt: Date.now(),
              format: subtitle.format,
              subtitleUrl: subtitle.url,
            });
            return {
              ...subtitle,
              url:
                `http://127.0.0.1:${server.address().port}` +
                `/subtitle/${subtitleToken}/subtitle.vtt`,
            };
          });
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
              mediaProxies.set(token, {
                createdAt: Date.now(),
                pageUrl: resolved.pageUrl,
                url: variant.url,
              });
              return {
                ...variant,
                url: `http://127.0.0.1:${server.address().port}/media/${token}/video.mp4`,
              };
            });
            deliveredUrl = deliveredVariants[0]?.url || deliveredUrl;
            if (resolved.analysis?.audioSourceUrl) {
              const audioToken = crypto.randomUUID();
              mediaProxies.set(audioToken, {
                createdAt: Date.now(),
                pageUrl: resolved.pageUrl,
                url: resolved.analysis.audioSourceUrl,
              });
              resolved.analysis.audioUrl = `http://127.0.0.1:${server.address().port}/media/${audioToken}/audio.m4a`;
              delete resolved.analysis.audioSourceUrl;
            }
          }
          const mediaType =
            resolved.candidateTypes?.[parsed.href] || "video/mp4";
          const isHls =
            mediaType === "application/vnd.apple.mpegurl" ||
            /\.m3u8(?:$|[?#])/i.test(parsed.href);
          onCapture({
            allowed: true,
            analysis: resolved.analysis || null,
            detectedAt: new Date().toISOString(),
            extension: isHls ? ".m3u8" : ".mp4",
            hostname: parsed.hostname,
            mime: isHls ? "application/vnd.apple.mpegurl" : "video/mp4",
            pageHost: new URL(resolved.pageUrl).hostname,
            pageUrl: resolved.pageUrl,
            size: resolved.candidateSizes?.[parsed.href] || 0,
            source: "Public page resolver",
            subtitles: resolved.subtitles || [],
            thumbnail: resolved.thumbnail || "",
            title: resolved.title || "",
            variants: deliveredVariants,
            url: deliveredUrl,
          });
        }
        json(
          response,
          202,
          { count: resolved.candidates.length, ok: true },
          origin,
        );
      } catch {
        json(
          response,
          400,
          { ok: false, message: "Invalid capture payload." },
          origin,
        );
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.shutdown = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  server.isPaired = () => Boolean(pairedOrigin);

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
  startCaptureBridge,
};
