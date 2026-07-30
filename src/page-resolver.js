"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { unpackedBinaryPath } = require("./binary-path");
const { classifyMedia, parseHttpUrl } = require("./policy");
const { genericProviderFor } = require("./provider-registry");
const { resolveReanimePage } = require("./reanime-resolver");

const YT_DLP_PATH = unpackedBinaryPath(
  path.join(
    path.dirname(require.resolve("@distube/yt-dlp")),
    "..",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  ),
);

function ytDlpJson(url, options = {}, execution = {}) {
  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
  ];
  if (options.format) args.push("--format", options.format);
  if (options.cookies) args.push("--cookies", options.cookies);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP_PATH,
      args,
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: execution.timeout || 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_PATH = /^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/;
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com"]);
const BILIBILI_PATH = /^\/video\/(BV[A-Za-z0-9]+)\/?$/i;
const DOUYIN_HOSTS = new Set(["douyin.com", "www.douyin.com"]);
const DOUYIN_SHORT_HOSTS = new Set(["v.douyin.com"]);
const DOUYIN_PATH = /^\/video\/(\d+)\/?$/;
const DOUYIN_SHORT_PATH = /^\/[A-Za-z0-9_-]+\/?$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const YOUTUBE_SHORT_HOSTS = new Set(["youtu.be"]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeJsonUrl(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }
}

function normalizePublicPage(rawUrl, options = {}) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const instagram =
    INSTAGRAM_HOSTS.has(host) && INSTAGRAM_PATH.test(parsed.pathname);
  const bilibili =
    BILIBILI_HOSTS.has(host) && BILIBILI_PATH.test(parsed.pathname);
  const douyin = DOUYIN_HOSTS.has(host) && DOUYIN_PATH.test(parsed.pathname);
  const douyinShort =
    DOUYIN_SHORT_HOSTS.has(host) && DOUYIN_SHORT_PATH.test(parsed.pathname);
  const youtubeId =
    (YOUTUBE_HOSTS.has(host) && parsed.pathname === "/watch"
      ? parsed.searchParams.get("v")
      : YOUTUBE_HOSTS.has(host) &&
          /^\/shorts\/([^/]+)\/?$/.test(parsed.pathname)
        ? parsed.pathname.match(/^\/shorts\/([^/]+)\/?$/)?.[1]
        : YOUTUBE_SHORT_HOSTS.has(host)
          ? parsed.pathname.split("/").filter(Boolean)[0]
          : "") || "";
  const youtube = YOUTUBE_VIDEO_ID.test(youtubeId);
  if (!instagram && !bilibili && !douyin && !douyinShort && !youtube) {
    return genericProviderFor(rawUrl, options.authorizedDomains)?.url || null;
  }
  if (youtube) {
    return `https://www.youtube.com/watch?v=${youtubeId}`;
  }
  parsed.search = "";
  parsed.hash = "";
  if (instagram) parsed.hostname = "www.instagram.com";
  if (bilibili) parsed.hostname = "www.bilibili.com";
  if (douyin) parsed.hostname = "www.douyin.com";
  if (douyinShort) parsed.hostname = "v.douyin.com";
  return parsed.href;
}

function extractCandidates(html, baseUrl = "") {
  const found = new Set();
  const metaPatterns = [
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/gi,
    /<meta[^>]+property=["']og:audio(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:audio(?::secure_url)?["']/gi,
  ];
  for (const pattern of metaPatterns) {
    for (const match of html.matchAll(pattern)) found.add(decodeHtml(match[1]));
  }
  for (const match of html.matchAll(
    /"(?:video_url|contentUrl)"\s*:\s*"((?:\\.|[^"\\])+)"/g,
  )) {
    found.add(decodeJsonUrl(match[1]));
  }
  for (const match of html.matchAll(
    /<(?:video|audio|source)[^>]+src=["']([^"']+)["']/gi,
  )) {
    found.add(decodeHtml(match[1]));
  }
  return [...found]
    .map((candidate) => {
      try {
        return new URL(candidate, baseUrl || undefined).href;
      } catch {
        return "";
      }
    })
    .filter((candidate) => classifyMedia(candidate).allowed);
}

function extractPageMetadata(html) {
  const readMeta = (property) => {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`,
        "i",
      ),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return decodeHtml(match[1]);
    }
    return "";
  };
  return { thumbnail: readMeta("og:image"), title: readMeta("og:title") };
}

async function resolvePublicPage(rawUrl, options = {}) {
  const genericProvider = genericProviderFor(rawUrl, options.authorizedDomains);
  const pageUrl = normalizePublicPage(rawUrl, options);
  if (!pageUrl) {
    return {
      ok: false,
      reason:
        "Use a supported provider, a complete direct media URL, a public-domain source, or an explicitly authorized domain.",
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (genericProvider?.id === "direct-media") {
    return resolveDirectMedia(pageUrl, fetchImpl);
  }
  if (genericProvider?.id === "nnyy") {
    return resolveNnyyPage(pageUrl, fetchImpl);
  }
  if (genericProvider?.id === "reanime") {
    return resolveReanimePage(pageUrl, fetchImpl);
  }
  const pageHost = new URL(pageUrl).hostname;
  if (
    genericProvider?.id === "public-content" &&
    /(?:^|\.)archive\.org$/i.test(pageHost)
  ) {
    const identifier = new URL(pageUrl).pathname.match(
      /^\/(?:details|download)\/([^/]+)/,
    )?.[1];
    if (identifier) {
      return resolveInternetArchive(pageUrl, identifier, fetchImpl);
    }
  }
  if (pageHost.endsWith("youtube.com")) {
    return resolveExtractorPage(pageUrl, options.extractor || ytDlpJson);
  }
  const bilibiliMatch = new URL(pageUrl).pathname.match(BILIBILI_PATH);
  if (bilibiliMatch) {
    return resolveBilibiliPage(pageUrl, bilibiliMatch[1], fetchImpl);
  }
  const response = await fetchImpl(pageUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return {
      ok: false,
      reason: `The public page returned HTTP ${response.status}.`,
    };
  }

  const html = await response.text();
  if (/loginForm|login_required|This Account is Private/i.test(html)) {
    return { ok: false, reason: "This post requires login or is not public." };
  }
  const metadata = extractPageMetadata(html);
  let candidates = extractCandidates(html, pageUrl);
  if (!candidates.length && !genericProvider && options.extractor !== false) {
    try {
      const info = await (options.extractor || ytDlpJson)(
        pageUrl,
        {
          dumpSingleJson: true,
          cookies: options.cookieFile,
          format: pageHost.endsWith("douyin.com")
            ? "best[vcodec^=h264]/best[vcodec^=avc]/best"
            : undefined,
          noPlaylist: true,
          noWarnings: true,
          skipDownload: true,
        },
        { timeout: 30_000 },
      );
      const entries = Array.isArray(info?.entries) ? info.entries : [info];
      const primary = entries[0] || {};
      metadata.thumbnail =
        primary.thumbnail ||
        [...(primary.thumbnails || [])].reverse().find((item) => item?.url)
          ?.url ||
        metadata.thumbnail;
      metadata.title = primary.title || primary.description || metadata.title;
      candidates = entries
        .flatMap((entry) => [
          ...(entry?.requested_downloads || []).map((item) => item?.url),
          entry?.url,
        ])
        .filter(Boolean)
        .filter((candidate) => {
          const parsed = parseHttpUrl(candidate);
          return Boolean(parsed);
        });
      candidates = [...new Set(candidates)];
    } catch {
      // The public extractor can fail when a post is private, removed, or rate-limited.
    }
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason: "The public page did not expose a complete playable MP4.",
    };
  }
  return {
    candidates,
    ok: true,
    pageUrl,
    provider: genericProvider?.id || "built-in",
    ...metadata,
  };
}

async function resolveDirectMedia(url, fetchImpl) {
  let contentType = "";
  let size = 0;
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `The direct media server returned HTTP ${response.status}.`,
      };
    }
    contentType = response.headers?.get?.("content-type") || "";
    size = Number(response.headers?.get?.("content-length")) || 0;
  } catch {
    // File extensions remain sufficient when a server does not implement HEAD.
  }
  const media = classifyMedia(url, contentType);
  if (!media.allowed) return { ok: false, reason: media.reason };
  return {
    candidateSizes: { [url]: size },
    candidateTypes: { [url]: contentType },
    candidates: [url],
    ok: true,
    pageUrl: url,
    provider: "direct-media",
    title: decodeURIComponent(path.basename(new URL(url).pathname)),
  };
}

async function resolveNnyyPage(pageUrl, fetchImpl) {
  const parsed = new URL(pageUrl);
  const movieId = parsed.pathname.match(/^\/dianying\/(\d+)\.html$/i)?.[1];
  if (!movieId) {
    return { ok: false, reason: "This nnyy.in movie URL is invalid." };
  }
  const endpoint = `https://nnyy.in/_gp/${encodeURIComponent(movieId)}/hd`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/json",
        Referer: pageUrl,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: "The nnyy.in media endpoint is unavailable." };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `The nnyy.in media endpoint returned HTTP ${response.status}.`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      reason: "The nnyy.in media endpoint returned invalid JSON.",
    };
  }
  const candidates = [
    ...new Set(
      (Array.isArray(payload?.video_plays) ? payload.video_plays : [])
        .map((entry) => String(entry?.play_data || "").trim())
        .filter((url) => classifyMedia(url).isHls),
    ),
  ];
  if (!candidates.length) {
    return {
      ok: false,
      reason: "This nnyy.in movie exposes no supported HLS playlist.",
    };
  }
  return {
    candidateTypes: Object.fromEntries(
      candidates.map((url) => [url, "application/vnd.apple.mpegurl"]),
    ),
    candidates,
    ok: true,
    pageUrl,
    provider: "nnyy",
    title: `nnyy.in movie ${movieId}`,
  };
}

async function resolveInternetArchive(pageUrl, identifier, fetchImpl) {
  const response = await fetchImpl(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    return {
      ok: false,
      reason: `Internet Archive metadata returned HTTP ${response.status}.`,
    };
  }
  const metadata = await response.json();
  const candidates = [];
  const candidateSizes = {};
  const candidateTypes = {};
  for (const file of metadata?.files || []) {
    if (!file?.name) continue;
    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${file.name
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    if (!classifyMedia(url, file?.mime).allowed) continue;
    candidates.push(url);
    candidateSizes[url] = Number(file.size) || 0;
    candidateTypes[url] = String(file?.mime || "");
    if (candidates.length >= 20) break;
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason:
        "This Internet Archive item exposes no complete supported media file.",
    };
  }
  return {
    candidateSizes,
    candidateTypes,
    candidates,
    ok: true,
    pageUrl,
    provider: "internet-archive",
    thumbnail: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    title: String(metadata?.metadata?.title || identifier),
  };
}

async function resolveExtractorPage(pageUrl, extractor) {
  try {
    const info = await extractor(
      pageUrl,
      {
        dumpSingleJson: true,
        format:
          "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/" +
          "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        noPlaylist: true,
        noWarnings: true,
        skipDownload: true,
      },
      { timeout: 30_000 },
    );
    const requested = [
      ...(info?.requested_formats || []),
      ...(info?.requested_downloads || []),
    ].filter((item) => parseHttpUrl(item?.url));
    const video =
      requested.find((item) => item?.vcodec && item.vcodec !== "none") ||
      (info?.vcodec && info.vcodec !== "none" && parseHttpUrl(info.url)
        ? info
        : null) ||
      requested.find(
        (item) =>
          parseHttpUrl(item?.url) &&
          (!item?.acodec || item.acodec === "none" || item?.vcodec !== "none"),
      );
    const audio =
      requested.find(
        (item) =>
          (!item?.vcodec || item.vcodec === "none") &&
          item?.acodec &&
          item.acodec !== "none",
      ) || null;
    if (!video?.url) {
      return {
        ok: false,
        reason: "The extractor did not expose a playable public video.",
      };
    }
    const height = Number(video.height) || 0;
    return {
      analysis: {
        audioCodec: audio?.acodec || video.acodec || "",
        audioSourceUrl: audio?.url || "",
        height,
        videoCodec: video.vcodec || "",
        width: Number(video.width) || 0,
      },
      candidateSizes: {
        [video.url]: Number(video.filesize || video.filesize_approx) || 0,
      },
      candidates: [video.url],
      ok: true,
      pageUrl,
      thumbnail:
        info.thumbnail ||
        [...(info.thumbnails || [])].reverse().find((item) => item?.url)?.url ||
        "",
      title: info.title || "",
      variants: [
        {
          height,
          label: height ? `${height}p` : "Best available",
          size: Number(video.filesize || video.filesize_approx) || 0,
          url: video.url,
        },
      ],
    };
  } catch {
    return {
      ok: false,
      reason:
        "The extractor could not resolve this page. It may be unsupported, private, restricted, or rate-limited.",
    };
  }
}

async function resolveBilibiliPage(pageUrl, bvid, fetchImpl) {
  const headers = {
    Accept: "application/json",
    Referer: pageUrl,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
  const viewResponse = await fetchImpl(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!viewResponse.ok) {
    return {
      ok: false,
      reason: `Bilibili metadata returned HTTP ${viewResponse.status}.`,
    };
  }
  const view = await viewResponse.json();
  const cid = view?.data?.cid || view?.data?.pages?.[0]?.cid;
  if (view?.code !== 0 || !cid) {
    return {
      ok: false,
      reason: "This Bilibili video is unavailable or not public.",
    };
  }
  const fetchQuality = async (qn) => {
    const playUrl =
      "https://api.bilibili.com/x/player/playurl?" +
      new URLSearchParams({
        bvid,
        cid: String(cid),
        fnval: "0",
        fourk: "1",
        qn: String(qn),
      });
    const response = await fetchImpl(playUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    return { payload: response.ok ? await response.json() : null, response };
  };
  const initial = await fetchQuality(127);
  const playResponse = initial.response;
  if (!playResponse.ok) {
    return {
      ok: false,
      reason: `Bilibili media returned HTTP ${playResponse.status}.`,
    };
  }
  const play = initial.payload;
  const qualities = play?.data?.accept_quality || [play?.data?.quality];
  const descriptions = play?.data?.accept_description || [];
  const resolvedQualities = await Promise.all(
    qualities.map(async (quality, index) => {
      const result =
        quality === play?.data?.quality
          ? play
          : (await fetchQuality(quality)).payload;
      const progressive = (result?.data?.durl || []).find((item) =>
        parseHttpUrl(item?.url),
      );
      if (!progressive) return null;
      const description = descriptions[index] || `${quality} quality`;
      const match = description.match(/(\d{3,4})P/i);
      return {
        height: match ? Number(match[1]) : 0,
        label: match ? `${match[1]}p` : description,
        quality,
        size: Number(progressive.size) || 0,
        url: progressive.url,
      };
    }),
  );
  const variants = resolvedQualities
    .filter(Boolean)
    .sort((left, right) => right.height - left.height);
  const progressive = variants[0];
  if (play?.code !== 0 || !progressive) {
    return {
      ok: false,
      reason: "Bilibili did not expose a combined public MP4.",
    };
  }
  return {
    candidateSizes: Object.fromEntries(
      variants.map((item) => [item.url, item.size]),
    ),
    candidates: [progressive.url],
    ok: true,
    pageUrl,
    thumbnail: String(view.data.pic || "").replace(/^http:\/\//i, "https://"),
    title: view.data.title || "",
    variants,
  };
}

module.exports = {
  extractCandidates,
  extractPageMetadata,
  normalizePublicPage,
  resolvePublicPage,
};
