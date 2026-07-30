"use strict";

const RESOLVE_URL = "http://127.0.0.1:48731/resolve";
const COMMANDS_URL = "http://127.0.0.1:48731/commands";
const BLOCKED_HOSTS = [];
const sentKeys = new Map();
const recentMediaByTab = new Map();
const pendingShareTabs = new Map();

function decodedUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function looksLikeAudioOnly(url) {
  return /(?:mime_type=audio|audio[_-](?:mp4|track)|\/audio\/|\.m4a(?:$|[?#])|\.mp3(?:$|[?#]))/i.test(
    decodedUrl(url)
  );
}

function mediaCodecScore(url) {
  if (looksLikeAudioOnly(url)) return -1_000;
  let score = 0;
  if (/(?:mime_type=video|video_id=|\/video\/)/i.test(decodedUrl(url))) {
    score += 70;
  }
  if (/(?:h264|avc|codec_type=0)/i.test(url)) score += 40;
  if (/(?:h265|hevc|codec_type=1)/i.test(url)) score -= 40;
  return score;
}

function recentMediaCandidates(tabId, fallback = "") {
  const now = Date.now();
  const candidates = [
    ...(recentMediaByTab.get(tabId) || []),
    ...(fallback ? [{ capturedAt: now, url: fallback }] : [])
  ].filter(
    (entry) =>
      now - entry.capturedAt < 90_000 &&
      !looksLikeAudioOnly(entry.url)
  );
  return candidates
    .sort((left, right) => {
      const leftScore = mediaCodecScore(left.url) - (now - left.capturedAt) / 4_000;
      const rightScore = mediaCodecScore(right.url) - (now - right.capturedAt) / 4_000;
      return rightScore - leftScore;
    })
    .map((entry) => entry.url)
    .filter((url, index, all) => index === all.indexOf(url))
    .slice(0, 4);
}

function preferredMediaUrl(tabId, fallback = "") {
  return recentMediaCandidates(tabId, fallback)[0] || fallback;
}

function looksLikeDouyinMedia(url, requestType = "") {
  try {
    const parsed = new URL(url);
    if (looksLikeAudioOnly(url)) return false;
    const mediaHost =
      /(?:douyinvod|bytecdn|bytefcdn|amemv|snssdk|pstatp|volccdn|zjcdn)\./i.test(
        parsed.hostname
      );
    return mediaHost && (
      requestType === "media" ||
      /(?:\.mp4(?:$|[?#])|video_id=|mime_type=video|tos-cn|playwm|play\/)/i.test(url)
    );
  } catch {
    return false;
  }
}

function looksLikeDouyinPageUrl(url) {
  try {
    return /(?:^|\.)douyin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function looksLikeDouyinAsset(url, requestType = "", contextUrl = "") {
  try {
    const parsed = new URL(url);
    const fromDouyin = looksLikeDouyinPageUrl(contextUrl);
    const mediaHost =
      /(?:douyin|byte|amemv|snssdk|pstatp|volc|zjcdn|ibytedtos)/i.test(
        parsed.hostname
      );
    return (
      (fromDouyin && requestType === "media") ||
      (mediaHost && (
        requestType === "media" ||
        /(?:\.mp4(?:$|[?#])|mime_type=(?:video|audio)|video_id=|audio_id=|tos|playwm|play\/)/i.test(
        decodedUrl(url)
      )
      ))
    );
  } catch {
    return false;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (
      details.tabId < 0 ||
      !looksLikeDouyinAsset(
        details.url,
        details.type,
        details.initiator || details.documentUrl || details.originUrl || ""
      )
    ) return;
    const entries = recentMediaByTab.get(details.tabId) || [];
    entries.unshift({ capturedAt: Date.now(), url: details.url });
    recentMediaByTab.set(
      details.tabId,
      entries
        .filter(
          (entry, index, all) =>
            index === all.findIndex((candidate) => candidate.url === entry.url)
        )
        .slice(0, 24)
    );
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

function blocked(hostname) {
  const host = String(hostname || "").toLowerCase();
  return BLOCKED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function pageKey(url, mediaUrl = "") {
  try {
    const parsed = new URL(url);
    const media = mediaUrl ? new URL(mediaUrl) : null;
    const modalId = parsed.searchParams.get("modal_id") || "";
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}:${modalId || media?.pathname || ""}`;
  } catch {
    return url;
  }
}

function supportedPage(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (["instagram.com", "www.instagram.com"].includes(host) &&
        /^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) ||
      (["bilibili.com", "www.bilibili.com"].includes(host) &&
        /^\/video\/BV[A-Za-z0-9]+\/?$/i.test(parsed.pathname)) ||
      (["douyin.com", "www.douyin.com"].includes(host) &&
        /^\/video\/\d+\/?$/.test(parsed.pathname)) ||
      (host === "v.douyin.com" && /^\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname))
      ||
      (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) &&
        ((parsed.pathname === "/watch" &&
          /^[A-Za-z0-9_-]{11}$/.test(parsed.searchParams.get("v") || "")) ||
          /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname))) ||
      (host === "youtu.be" && /^\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

function browserSafe(url) {
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !blocked(parsed.hostname) &&
      !parsed.searchParams.has("bytestart") &&
      !parsed.searchParams.has("byteend")
    );
  } catch {
    return false;
  }
}

async function resolvePage(pageUrl, media = {}) {
  if (!supportedPage(pageUrl)) return false;
  const key = pageKey(pageUrl, media.mediaUrl);
  const previous = sentKeys.get(key) || 0;
  if (Date.now() - previous < 30_000) return false;
  sentKeys.set(key, Date.now());

  try {
    const response = await fetch(RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaUrl: media.mediaUrl || "",
        mediaCandidates:
          media.mediaCandidates ||
          (recentMediaByTab.get(media.tabId) || []).map((entry) => entry.url).slice(0, 16),
        pageUrl,
        thumbnail: media.thumbnail || "",
        title: media.title || ""
      })
    });
    await chrome.storage.local.set({
      bridgeOnline: response.ok,
      lastCaptureAt: response.ok ? Date.now() : 0
    });
    if (!response.ok) sentKeys.delete(key);
    return response.ok;
  } catch {
    sentKeys.delete(key);
    await chrome.storage.local.set({ bridgeOnline: false });
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "media-played") return;
  const networkMedia = preferredMediaUrl(sender.tab?.id, message.mediaUrl);
  const allCandidates = (recentMediaByTab.get(sender.tab?.id) || [])
    .map((entry) => entry.url)
    .slice(0, 16);
  (async () => {
    const resolved = await resolvePage(sender.tab?.url || message.pageUrl || "", {
      ...message,
      mediaCandidates: allCandidates,
      mediaUrl: networkMedia
    });
    if (resolved && pendingShareTabs.has(sender.tab?.id)) {
      await finishPendingShareTab(sender.tab.id);
    }
  })();
});

async function finishPendingShareTab(tabId) {
  const pending = pendingShareTabs.get(tabId);
  if (!pending) return;
  pendingShareTabs.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  if (pending.returnTabId) {
    await chrome.tabs.update(pending.returnTabId, { active: true }).catch(() => {});
  }
}

async function tryPendingShareTab(tabId) {
  const pending = pendingShareTabs.get(tabId);
  if (!pending) return;
  if (Date.now() - pending.startedAt > 18_000) {
    await finishPendingShareTab(tabId);
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    pendingShareTabs.delete(tabId);
    return;
  }
  await chrome.tabs
    .sendMessage(tabId, { autoplay: true, type: "capture-now" })
    .catch(() => ({}));
  await new Promise((resolve) => setTimeout(resolve, 900));
  const payload =
    await chrome.tabs.sendMessage(tabId, { type: "capture-now" }).catch(() => ({}));
  const networkMedia = preferredMediaUrl(tabId, payload?.mediaUrl);
  const allCandidates = (recentMediaByTab.get(tabId) || [])
    .map((entry) => entry.url)
    .slice(0, 16);
  if (networkMedia) {
    const resolved = await resolvePage(tab.url || payload?.pageUrl || "", {
      ...payload,
      mediaCandidates: allCandidates,
      mediaUrl: networkMedia
    });
    if (resolved) {
      await finishPendingShareTab(tabId);
      return;
    }
  }
  setTimeout(() => tryPendingShareTab(tabId), 1_500);
}

async function captureSupportedTab(tabId, tabUrl = "") {
  const tab = tabUrl
    ? { id: tabId, url: tabUrl }
    : await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !supportedPage(tab.url || "")) return;
  const payload =
    await chrome.tabs.sendMessage(tab.id, { type: "capture-now" }).catch(() => ({}));
  const networkMedia = preferredMediaUrl(tab.id, payload?.mediaUrl);
  const allCandidates = (recentMediaByTab.get(tab.id) || [])
    .map((entry) => entry.url)
    .slice(0, 16);
  await resolvePage(tab.url || payload?.pageUrl || "", {
    ...payload,
    mediaCandidates: allCandidates,
    mediaUrl: networkMedia,
    tabId: tab.id
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && pendingShareTabs.has(tabId)) {
    setTimeout(() => tryPendingShareTab(tabId), 1_200);
  }
  if (
    (changeInfo.status === "complete" || typeof changeInfo.url === "string") &&
    supportedPage(changeInfo.url || tab.url || "")
  ) {
    setTimeout(() => captureSupportedTab(tabId), 900);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  setTimeout(() => captureSupportedTab(tabId), 350);
});

let polling = false;

async function pollCommands() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch(COMMANDS_URL, { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      for (const command of payload.commands || []) {
        if (command.type === "open-media" && browserSafe(command.url)) {
          await chrome.tabs.create({ active: true, url: command.url });
        } else if (command.type === "capture-active") {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            const payload =
              await chrome.tabs.sendMessage(tab.id, { type: "capture-now" }).catch(() => ({}));
            const networkMedia = preferredMediaUrl(tab.id, payload?.mediaUrl);
            const allCandidates = (recentMediaByTab.get(tab.id) || [])
              .map((entry) => entry.url)
              .slice(0, 16);
            await resolvePage(tab.url || payload?.pageUrl || "", {
              ...payload,
              mediaCandidates: allCandidates,
              mediaUrl: networkMedia
            });
          }
        } else if (
          command.type === "resolve-douyin-share" &&
          supportedPage(command.url || "") &&
          /(?:^|\.)douyin\.com$/i.test(new URL(command.url).hostname)
        ) {
          const [returnTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
          });
          const tab = await chrome.tabs.create({ active: true, url: command.url });
          if (tab?.id) {
            pendingShareTabs.set(tab.id, {
              returnTabId: returnTab?.id,
              startedAt: Date.now()
            });
          }
        }
      }
      await chrome.storage.local.set({ bridgeOnline: true });
    }
  } catch {
    await chrome.storage.local.set({ bridgeOnline: false });
  } finally {
    polling = false;
    setTimeout(pollCommands, 1500);
  }
}

pollCommands();
