"use strict";

let lastReportedPage = "";

function recentNetworkMediaUrl() {
  const mediaHosts = /(?:douyinvod|bytecdn|bytefcdn|amemv|snssdk|pstatp)\./i;
  return (
    [...performance.getEntriesByType("resource")]
      .reverse()
      .filter(
        (entry) =>
          entry.initiatorType === "video" ||
          /(?:\.mp4(?:[?#]|$)|mime_type=video|video_id=|douyinvod)/i.test(
            entry.name,
          ),
      )
      .map((entry) => entry.name)
      .find((url) => /^https?:/i.test(url) && mediaHosts.test(url)) || ""
  );
}

function absoluteUrl(value) {
  try {
    return new URL(value, location.href).href;
  } catch {
    return "";
  }
}

function findThumbnail(media) {
  const direct =
    media?.poster ||
    media?.getAttribute("poster") ||
    document.querySelector('meta[property="og:image"]')?.content;
  if (direct) return absoluteUrl(direct);

  const mediaRect = media?.getBoundingClientRect();
  const nearby = [...document.images]
    .filter((image) => image.currentSrc || image.src)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      const overlap = mediaRect
        ? Math.max(
            0,
            Math.min(rect.right, mediaRect.right) -
              Math.max(rect.left, mediaRect.left),
          ) *
          Math.max(
            0,
            Math.min(rect.bottom, mediaRect.bottom) -
              Math.max(rect.top, mediaRect.top),
          )
        : 0;
      return { area: rect.width * rect.height, image, overlap };
    })
    .filter(({ area, image }) => area > 10_000 && image.complete)
    .sort(
      (left, right) => right.overlap - left.overlap || right.area - left.area,
    )[0]?.image;
  return absoluteUrl(nearby?.currentSrc || nearby?.src || "");
}

function currentMediaPayload() {
  const media = targetMedia();
  if (!media) return null;
  return {
    mediaUrl: /^https?:/i.test(media.currentSrc || media.src || "")
      ? media.currentSrc || media.src
      : recentNetworkMediaUrl(),
    pageUrl: location.href,
    thumbnail: findThumbnail(media),
    title:
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title ||
      "",
  };
}

function targetMedia() {
  const media = [...document.querySelectorAll("video, audio")];
  const playing = media.find(
    (item) => !item.paused && !item.ended && item.readyState > 1,
  );
  if (playing) return playing;
  return media
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const visibleWidth = Math.max(
        0,
        Math.min(innerWidth, rect.right) - Math.max(0, rect.left),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top),
      );
      return { item, visibleArea: visibleWidth * visibleHeight };
    })
    .sort((left, right) => right.visibleArea - left.visibleArea)[0]?.item;
}

function reportPlayingMedia(force = false) {
  const media = targetMedia();
  const playingMedia =
    media && !media.paused && !media.ended && media.readyState > 1;
  if (!force && !playingMedia) return;
  if (!media) return;
  if (!force && lastReportedPage === location.href) return;
  lastReportedPage = location.href;
  chrome.runtime
    .sendMessage({ ...currentMediaPayload(), type: "media-played" })
    .catch(() => {});
}

document.addEventListener("play", () => reportPlayingMedia(true), true);
document.addEventListener("loadeddata", () => reportPlayingMedia(), true);
document.addEventListener(
  "copy",
  () => setTimeout(() => reportPlayingMedia(true), 120),
  true,
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "capture-now") {
    const media = targetMedia();
    if (message.autoplay && media?.paused) {
      media.muted = true;
      media.play().catch(() => {
        const rect = media.getBoundingClientRect();
        media.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            view: window,
          }),
        );
      });
    }
    const payload = currentMediaPayload();
    if (payload) {
      chrome.runtime
        .sendMessage({ ...payload, type: "media-played" })
        .catch(() => {});
    }
    sendResponse(payload || {});
  }
});

const observer = new MutationObserver(() => reportPlayingMedia());
observer.observe(document.documentElement, { childList: true, subtree: true });

let knownLocation = location.href;
setInterval(() => {
  if (knownLocation !== location.href) {
    knownLocation = location.href;
    lastReportedPage = "";
  }
  reportPlayingMedia();
}, 1500);
