"use strict";

const browser = document.querySelector("#browser");
const addressForm = document.querySelector("#addressForm");
const addressInput = document.querySelector("#addressInput");
const backButton = document.querySelector("#backButton");
const forwardButton = document.querySelector("#forwardButton");
const reloadButton = document.querySelector("#reloadButton");
const clearButton = document.querySelector("#clearButton");
const resultCount = document.querySelector("#resultCount");
const emptyState = document.querySelector("#emptyState");
const resultsList = document.querySelector("#resultsList");
const captureLibrary = document.querySelector("#captureLibrary");
const resultTemplate = document.querySelector("#resultTemplate");
const toast = document.querySelector("#toast");
const videoCountElement = document.querySelector("#videoCount");
const audioCountElement = document.querySelector("#audioCount");
const totalSizeElement = document.querySelector("#totalSize");
const navCount = document.querySelector("#navCount");
const workspace = document.querySelector(".workspace");
const browserToolbar = document.querySelector("#browserToolbar");
const navButtons = [...document.querySelectorAll(".nav-button")];
const appViews = [...document.querySelectorAll(".app-view")];
const pinButton = document.querySelector("#pinButton");
const minimizeWindowButton = document.querySelector("#minimizeWindow");
const maximizeWindowButton = document.querySelector("#maximizeWindow");
const closeWindowButton = document.querySelector("#closeWindow");
const extensionPath = document.querySelector("#extensionPath");
const guideExtensionPath = document.querySelector("#guideExtensionPath");
const copyExtensionPathButton = document.querySelector("#copyExtensionPath");
const showExtensionFolderButton = document.querySelector("#showExtensionFolder");
const returnToCaptureButton = document.querySelector("#returnToCapture");
const downloadDirectoryElement = document.querySelector("#downloadDirectory");
const browseDownloadDirectoryButton = document.querySelector(
  "#browseDownloadDirectory"
);
const previewDialog = document.querySelector("#previewDialog");
const closePreviewButton = document.querySelector("#closePreviewButton");
const videoPreview = document.querySelector("#videoPreview");
const audioPreview = document.querySelector("#audioPreview");
const audioPreviewWrap = document.querySelector("#audioPreviewWrap");
const previewError = document.querySelector("#previewError");
const previewTitle = document.querySelector("#previewTitle");
const previewHost = document.querySelector("#previewHost");
const previewMeta = document.querySelector("#previewMeta");
const previewDownloadButton = document.querySelector("#previewDownloadButton");
const rightsDialog = document.querySelector("#rightsDialog");
const cancelRightsButton = document.querySelector("#cancelRightsButton");
const confirmRightsButton = document.querySelector("#confirmRightsButton");

let count = 0;
let videoCount = 0;
let audioCount = 0;
let totalKnownSize = 0;
let activePreview = null;
let previewCodecTimer;
let previewCompatibilityAttempted = false;
let previewFrameDecoded = false;
let pendingRightsDownload = null;
let toastTimer;
const downloadViews = new Map();

function updatePinState(pinned) {
  pinButton.classList.toggle("active", pinned);
  pinButton.setAttribute("aria-pressed", String(pinned));
  pinButton.title = pinned ? "Stop keeping Media Scout on top" : "Keep Media Scout on top";
  pinButton.setAttribute("aria-label", pinButton.title);
}

function formatBytes(bytes) {
  if (!bytes) return "Size unknown";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent]}`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

function registerDownloadView(url, update) {
  if (!downloadViews.has(url)) downloadViews.set(url, new Set());
  downloadViews.get(url).add(update);
}

function updateDownloadViews(url, state) {
  for (const update of downloadViews.get(url) || []) update(state);
}

async function requestDownload(media, setDownloadState = () => {}) {
  setDownloadState({ mode: "preparing" });
  const result = await window.mediaScout.downloadMedia(
    media.url,
    media.analysis?.audioUrl || "",
    media.title || "",
    media.pageUrl || ""
  );
  if (result.needsPermission) {
    pendingRightsDownload = { media, setDownloadState };
    rightsDialog.showModal();
    return;
  }
  if (!result.ok) setDownloadState({ mode: "error" });
}

function updateCount() {
  resultCount.textContent = String(count);
  videoCountElement.textContent = String(videoCount);
  audioCountElement.textContent = String(audioCount);
  totalSizeElement.textContent = totalKnownSize ? formatBytes(totalKnownSize) : "—";
  navCount.textContent = String(count);
  navCount.classList.toggle("has-items", count > 0);
  emptyState.style.display = count === 0 ? "grid" : "none";
  resultsList.style.display = count === 0 ? "none" : "block";
}

function selectView(viewName) {
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  appViews.forEach((view) => {
    view.classList.toggle("active", view.id === `${viewName}View`);
  });
  workspace.classList.toggle("settings-open", viewName === "settings");
  workspace.classList.toggle("setup-open", viewName === "setup");
  workspace.classList.toggle("supports-open", viewName === "supports");
  workspace.classList.toggle("captures-open", viewName === "captures");
  workspace.classList.toggle("about-open", viewName === "about");
  browserToolbar.hidden = viewName !== "browser";
}

function closePreview() {
  clearTimeout(previewCodecTimer);
  previewError.classList.remove("loading");
  videoPreview.pause();
  audioPreview.pause();
  videoPreview.removeAttribute("src");
  audioPreview.removeAttribute("src");
  videoPreview.load();
  audioPreview.load();
  activePreview = null;
  previewDialog.close();
}

function openPreview(media) {
  clearTimeout(previewCodecTimer);
  previewCompatibilityAttempted = false;
  previewFrameDecoded = false;
  activePreview = media;
  const isAudio = media.mime.startsWith("audio/");
  previewTitle.textContent = media.title || `${isAudio ? "Audio" : "Video"} preview`;
  previewHost.textContent = media.label || (isAudio ? "Audio" : "Video");
  previewMeta.textContent = `${media.extension || media.mime} • ${formatBytes(media.size)}`;
  previewError.textContent = "";
  previewError.style.display = "none";
  previewError.classList.remove("loading");
  videoPreview.style.display = isAudio ? "none" : "block";
  audioPreviewWrap.style.display = isAudio ? "flex" : "none";

  const player = isAudio ? audioPreview : videoPreview;
  previewDialog.showModal();
  const videoCodec = media.analysis?.videoCodec || "";
  if (false && !isAudio && videoCodec && !/^(?:h264|avc)/i.test(videoCodec)) {
    previewCompatibilityAttempted = true;
    videoPreview.style.display = "none";
    previewError.textContent = "Loading preview…";
    previewError.style.display = "grid";
    previewError.classList.add("loading");
    window.mediaScout
      .prepareCompatiblePreview(media.url, media.analysis?.audioUrl)
      .then((result) => {
      if (!activePreview) return;
      previewError.classList.remove("loading");
      if (!result.ok) {
        previewError.textContent =
          "Preview unavailable. You can still save the media.";
        return;
      }
      videoPreview.style.display = "block";
      videoPreview.src = result.url;
      videoPreview.load();
      videoPreview.play().catch(() => {});
      });
    return;
  }
  player.src = media.url;
  if (!isAudio && media.analysis?.audioUrl) {
    audioPreview.src = media.analysis.audioUrl;
    audioPreview.load();
  }
  player.load();
  player.play().catch(() => {});
}

function createMediaCard(media) {
  const fragment = resultTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".media-card");
  const isAudio = media.mime.startsWith("audio/");
  const type = isAudio ? "Audio" : "Video";
  const previewTile = fragment.querySelector(".preview-tile");
  const thumbnail = fragment.querySelector(".media-thumbnail");
  const qualityControl = fragment.querySelector(".quality-control");
  const qualitySelect = fragment.querySelector(".quality-select");
  const sizeElement = fragment.querySelector(".media-size");
  const downloadButton = fragment.querySelector(".download-button");
  const downloadLabel = fragment.querySelector(".download-label");
  const downloadStatusLabel = fragment.querySelector(".download-status-label");
  const downloadPercent = fragment.querySelector(".download-percent");
  const downloadFill = fragment.querySelector(".download-fill");
  const variants = media.variants?.length
    ? media.variants
    : [{ label: "Best available", size: media.size || 0, url: media.url }];
  variants.forEach((variant, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = variant.label || `Option ${index + 1}`;
    qualitySelect.append(option);
  });
  const setDownloadState = ({ mode = "idle", percent = 0 } = {}) => {
    card.dataset.downloadState = mode;
    downloadButton.disabled = ["preparing", "downloading"].includes(mode);
    downloadFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    downloadPercent.textContent = mode === "downloading" ? `${Math.round(percent)}%` : "";
    if (mode === "preparing") {
      downloadLabel.textContent = "Preparing";
      downloadStatusLabel.textContent = "Preparing download…";
    } else if (mode === "downloading") {
      downloadLabel.textContent = "Downloading";
      downloadStatusLabel.textContent = "Downloading media";
    } else if (mode === "saved") {
      downloadLabel.textContent = "Saved";
      downloadStatusLabel.textContent = "Saved to your download folder";
      downloadPercent.textContent = "100%";
      downloadFill.style.width = "100%";
    } else if (mode === "error") {
      downloadLabel.textContent = "Retry";
      downloadStatusLabel.textContent = "Download failed";
    } else {
      downloadLabel.textContent = "Save";
      downloadStatusLabel.textContent = "";
      downloadPercent.textContent = "";
      downloadFill.style.width = "0%";
    }
  };
  variants.forEach((variant) => registerDownloadView(variant.url, setDownloadState));
  qualityControl.classList.toggle("single-quality", variants.length === 1);
  const selectedMedia = () => {
    const variant = variants[Number(qualitySelect.value) || 0];
    return { ...media, ...variant, variants: media.variants };
  };
  const updateVariantDetails = () => {
    const selected = selectedMedia();
    sizeElement.textContent = formatBytes(selected.size);
  };
  qualitySelect.addEventListener("change", updateVariantDetails);
  card.classList.toggle("is-audio", isAudio);
  if (media.thumbnail) {
    thumbnail.addEventListener("load", () => previewTile.classList.add("has-thumbnail"));
    thumbnail.addEventListener("error", () => {
      thumbnail.removeAttribute("src");
      addVideoThumbnail();
    });
    thumbnail.src = media.thumbnail;
  } else {
    addVideoThumbnail();
  }

  function addVideoThumbnail() {
    if (isAudio || !/douyin\.com$/i.test(media.pageHost || "")) return;
    if (previewTile.querySelector(".media-thumbnail-video")) return;
    const videoThumbnail = document.createElement("video");
    videoThumbnail.className = "media-thumbnail media-thumbnail-video";
    videoThumbnail.muted = true;
    videoThumbnail.playsInline = true;
    videoThumbnail.preload = "metadata";
    videoThumbnail.src = media.url;
    videoThumbnail.addEventListener("loadeddata", () => {
      previewTile.classList.add("has-thumbnail", "has-video-thumbnail");
      if (videoThumbnail.duration > 0.2) videoThumbnail.currentTime = 0.15;
    });
    previewTile.prepend(videoThumbnail);
  }
  fragment.querySelector(".media-type").textContent = media.extension || type;
  fragment.querySelector(".media-time").textContent = new Date(
    media.detectedAt
  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  fragment.querySelector(".media-host").textContent = media.title || media.hostname;
  fragment.querySelector(".media-host").title = media.title || media.hostname;
  sizeElement.textContent = formatBytes(media.size);
  const analysis = media.analysis;
  fragment.querySelector(".media-source").textContent = analysis?.videoCodec
    ? `${analysis.videoCodec.toUpperCase()}${analysis.height ? ` · ${analysis.height}p` : ""}`
    : media.source || media.pageHost || "Direct source";
  previewTile.addEventListener("click", () => openPreview(selectedMedia()));
  downloadButton.addEventListener("click", () =>
    requestDownload(selectedMedia(), setDownloadState)
  );
  updateVariantDetails();
  return card;
}

async function navigate(rawUrl) {
  let value = rawUrl.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const result = await window.mediaScout.validateNavigation(value);
  if (!result.ok) {
    showToast(result.message);
    return;
  }
  browser.loadURL(result.url);
}

async function loadInitialPage() {
  const config = await window.mediaScout.getConfig();
  extensionPath.textContent = config.extensionPath;
  guideExtensionPath.textContent = config.extensionPath;
  guideExtensionPath.title = config.extensionPath;
  downloadDirectoryElement.textContent = config.downloadDirectory;
  downloadDirectoryElement.title = config.downloadDirectory;
  updatePinState(config.alwaysOnTop);
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});

browseDownloadDirectoryButton.addEventListener("click", async () => {
  const result = await window.mediaScout.chooseDownloadDirectory();
  if (!result.ok) return;
  downloadDirectoryElement.textContent = result.downloadDirectory;
  downloadDirectoryElement.title = result.downloadDirectory;
  showToast("Download location updated.");
});

copyExtensionPathButton.addEventListener("click", async () => {
  await window.mediaScout.copyExtensionPath();
  showToast("Extension folder path copied.");
});

showExtensionFolderButton.addEventListener("click", async () => {
  await window.mediaScout.showExtensionFolder();
});

returnToCaptureButton.addEventListener("click", () => selectView("browser"));

pinButton.addEventListener("click", async () => {
  const result = await window.mediaScout.toggleAlwaysOnTop();
  if (!result.ok) return;
  updatePinState(result.alwaysOnTop);
  showToast(result.alwaysOnTop ? "Pinned on top" : "Pin disabled");
});

minimizeWindowButton.addEventListener("click", () => window.mediaScout.minimizeWindow());
maximizeWindowButton.addEventListener("click", async () => {
  const result = await window.mediaScout.toggleMaximizeWindow();
  maximizeWindowButton.classList.toggle("restore", result.maximized);
  maximizeWindowButton.title = result.maximized ? "Restore" : "Maximize";
  maximizeWindowButton.setAttribute("aria-label", maximizeWindowButton.title);
});
closeWindowButton.addEventListener("click", () => window.mediaScout.closeWindow());

videoPreview.addEventListener("error", () => {
  if (activePreview && !activePreview.mime.startsWith("audio/")) {
    videoPreview.style.display = "none";
    previewError.classList.remove("loading");
    previewError.textContent =
      "This source cannot be previewed directly, but it may still be saved.";
    previewError.style.display = "grid";
  }
});
videoPreview.addEventListener("canplay", () => {
  previewError.classList.remove("loading");
  previewError.style.display = "none";
});
videoPreview.addEventListener("playing", () => {
  clearTimeout(previewCodecTimer);
  previewFrameDecoded = false;
  if (activePreview?.analysis?.audioUrl) {
    audioPreview.currentTime = videoPreview.currentTime;
    audioPreview.playbackRate = videoPreview.playbackRate;
    audioPreview.volume = videoPreview.volume;
    audioPreview.muted = videoPreview.muted;
    audioPreview.play().catch(() => {});
  }
  if (typeof videoPreview.requestVideoFrameCallback === "function") {
    videoPreview.requestVideoFrameCallback(() => {
      previewFrameDecoded = true;
    });
  } else {
    previewFrameDecoded = videoPreview.videoWidth > 0;
  }
  previewCodecTimer = setTimeout(() => {
    if (
      false &&
      activePreview &&
      /douyin\.com$/i.test(activePreview.pageHost || "") &&
      (videoPreview.videoWidth === 0 || !previewFrameDecoded) &&
      !previewCompatibilityAttempted
    ) {
      previewCompatibilityAttempted = true;
      videoPreview.pause();
      videoPreview.style.display = "none";
      previewError.textContent = "Loading preview…";
      previewError.style.display = "grid";
      previewError.classList.add("loading");
      window.mediaScout
        .prepareCompatiblePreview(
          activePreview.url,
          activePreview.analysis?.audioUrl
        )
        .then((result) => {
        if (!activePreview) return;
        previewError.classList.remove("loading");
        if (!result.ok) {
          previewError.textContent =
            "Preview unavailable. You can still save the media.";
          return;
        }
        videoPreview.style.display = "block";
        videoPreview.src = result.url;
        videoPreview.load();
        videoPreview.play().catch(() => {});
        });
    }
  }, 1400);
});

videoPreview.addEventListener("pause", () => audioPreview.pause());
videoPreview.addEventListener("seeking", () => {
  if (activePreview?.analysis?.audioUrl) {
    audioPreview.currentTime = videoPreview.currentTime;
  }
});
videoPreview.addEventListener("ratechange", () => {
  audioPreview.playbackRate = videoPreview.playbackRate;
});
videoPreview.addEventListener("volumechange", () => {
  audioPreview.volume = videoPreview.volume;
  audioPreview.muted = videoPreview.muted;
});
audioPreview.addEventListener("error", () => {
  if (activePreview && activePreview.mime.startsWith("audio/")) {
    audioPreviewWrap.style.display = "none";
    previewError.classList.remove("loading");
    previewError.textContent =
      "This source cannot be previewed directly, but it may still be saved.";
    previewError.style.display = "grid";
  }
});
audioPreview.addEventListener("canplay", () => {
  previewError.classList.remove("loading");
  previewError.style.display = "none";
});
closePreviewButton.addEventListener("click", closePreview);
previewDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePreview();
});
previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) closePreview();
});
previewDownloadButton.addEventListener("click", async () => {
  if (!activePreview) return;
  await requestDownload(activePreview);
});

cancelRightsButton.addEventListener("click", () => {
  pendingRightsDownload?.setDownloadState({ mode: "idle" });
  pendingRightsDownload = null;
  rightsDialog.close();
});

rightsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelRightsButton.click();
});

confirmRightsButton.addEventListener("click", async () => {
  if (!pendingRightsDownload) return;
  confirmRightsButton.disabled = true;
  await window.mediaScout.confirmDownloadRights();
  const pending = pendingRightsDownload;
  pendingRightsDownload = null;
  rightsDialog.close();
  confirmRightsButton.disabled = false;
  const result = await window.mediaScout.downloadMedia(
    pending.media.url,
    pending.media.analysis?.audioUrl || "",
    pending.media.title || "",
    pending.media.pageUrl || ""
  );
  if (!result.ok) pending.setDownloadState({ mode: "error" });
});

addressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});
backButton.addEventListener("click", () => {
  if (browser.canGoBack()) browser.goBack();
});
forwardButton.addEventListener("click", () => {
  if (browser.canGoForward()) browser.goForward();
});
reloadButton.addEventListener("click", () => browser.reload());
clearButton.addEventListener("click", async () => {
  resultsList.replaceChildren();
  captureLibrary.replaceChildren();
  count = 0;
  videoCount = 0;
  audioCount = 0;
  totalKnownSize = 0;
  downloadViews.clear();
  await window.mediaScout.clearMedia();
  updateCount();
});

browser.addEventListener("did-navigate", (event) => {
  addressInput.value = event.url;
  window.mediaScout.resolvePage(event.url).catch(() => {});
});
browser.addEventListener("did-navigate-in-page", (event) => {
  addressInput.value = event.url;
  window.mediaScout.resolvePage(event.url).catch(() => {});
});
browser.addEventListener("will-navigate", async (event) => {
  const validation = await window.mediaScout.validateNavigation(event.url);
  if (!validation.ok) {
    browser.stop();
    showToast(validation.message);
  }
});

window.mediaScout.onDetected((media) => {
  resultsList.prepend(createMediaCard(media));
  count += 1;
  if (media.mime.startsWith("audio/")) audioCount += 1;
  else videoCount += 1;
  totalKnownSize += media.size || 0;
  updateCount();
});

window.mediaScout.onDownloadStarted((download) => {
  updateDownloadViews(download.url, { mode: "downloading", percent: 0 });
  showToast(`Downloading ${download.filename}…`);
});
window.mediaScout.onDownloadProgress((download) => {
  const percent = download.totalBytes
    ? (download.receivedBytes / download.totalBytes) * 100
    : 0;
  updateDownloadViews(download.url, { mode: "downloading", percent });
});
window.mediaScout.onDownloadFinished((download) => {
  updateDownloadViews(download.url, {
    mode: download.state === "completed" ? "saved" : "error",
    percent: download.state === "completed" ? 100 : 0
  });
  showToast(
    download.state === "completed"
      ? `Saved ${download.filename}`
      : `Download ${download.state}.`
  );
});

updateCount();
loadInitialPage();
