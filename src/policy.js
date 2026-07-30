"use strict";

const BLOCKED_HOST_SUFFIXES = Object.freeze([]);

const DIRECT_MEDIA_EXTENSIONS = Object.freeze([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".flac"
]);

const MEDIA_MIME_PREFIXES = Object.freeze(["video/", "audio/"]);
const EXCLUDED_MIME_TYPES = Object.freeze([
  "video/mp2t",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml"
]);

function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

function isBlockedHost(hostname) {
  normalizeHost(hostname);
  return false;
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function extensionFromPath(pathname) {
  const lower = String(pathname || "").toLowerCase();
  return DIRECT_MEDIA_EXTENSIONS.find((extension) => lower.endsWith(extension)) || "";
}

function normalizeMime(contentType) {
  return String(contentType || "").split(";", 1)[0].trim().toLowerCase();
}

function classifyMedia(url, contentType = "") {
  const parsed = parseHttpUrl(url);
  if (!parsed) return { allowed: false, reason: "Only HTTP(S) URLs are supported." };
  if (isBlockedHost(parsed.hostname)) {
    return { allowed: false, reason: "This provider is excluded by policy." };
  }
  if (parsed.searchParams.has("bytestart") || parsed.searchParams.has("byteend")) {
    return {
      allowed: false,
      reason: "This URL is a partial byte-range fragment, not a complete media file."
    };
  }

  const mime = normalizeMime(contentType);
  if (EXCLUDED_MIME_TYPES.includes(mime)) {
    return {
      allowed: false,
      reason: "Playlist, segmented, and adaptive-stream formats are not supported."
    };
  }

  const extension = extensionFromPath(parsed.pathname);
  const directMime = MEDIA_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
  if (!extension && !directMime) {
    return { allowed: false, reason: "The response is not a direct media file." };
  }

  return {
    allowed: true,
    hostname: parsed.hostname,
    extension,
    mime: mime || "unknown",
    url: parsed.href
  };
}

module.exports = {
  BLOCKED_HOST_SUFFIXES,
  DIRECT_MEDIA_EXTENSIONS,
  classifyMedia,
  isBlockedHost,
  normalizeMime,
  parseHttpUrl
};
