"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaScout", {
  getConfig: () => ipcRenderer.invoke("app:get-config"),
  chooseDownloadDirectory: () =>
    ipcRenderer.invoke("settings:choose-download-directory"),
  copyExtensionPath: () => ipcRenderer.invoke("extension:copy-path"),
  showExtensionFolder: () => ipcRenderer.invoke("extension:show-folder"),
  forceRefresh: () => ipcRenderer.invoke("extension:force-refresh"),
  getExtensionStatus: () => ipcRenderer.invoke("extension:status"),
  resetPairing: () => ipcRenderer.invoke("extension:reset-pairing"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  confirmDownloadRights: () =>
    ipcRenderer.invoke("settings:confirm-download-rights"),
  updatePreferences: (preferences) =>
    ipcRenderer.invoke("settings:update-preferences", preferences),
  validateNavigation: (url) => ipcRenderer.invoke("navigation:validate", url),
  resolvePage: (url) => ipcRenderer.invoke("page:resolve", url),
  copyMedia: (url) => ipcRenderer.invoke("media:copy", url),
  downloadMedia: (url, audioUrl, title, pageUrl, subtitleUrl) =>
    ipcRenderer.invoke(
      "media:download",
      url,
      audioUrl,
      title,
      pageUrl,
      subtitleUrl,
    ),
  cancelDownload: (url) => ipcRenderer.invoke("media:cancel", url),
  togglePauseDownload: (url) => ipcRenderer.invoke("media:toggle-pause", url),
  prepareCompatiblePreview: (url, audioUrl) =>
    ipcRenderer.invoke("media:compatible-preview", url, audioUrl),
  openInBrowser: (url) => ipcRenderer.invoke("media:open-browser", url),
  clearMedia: () => ipcRenderer.invoke("media:clear"),
  exportMediaMetadata: (media) =>
    ipcRenderer.invoke("media:export-metadata", media),
  batchCapture: (urls) => ipcRenderer.invoke("capture:batch", urls),
  getHistory: () => ipcRenderer.invoke("history:list"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getDownloadQueue: () => ipcRenderer.invoke("downloads:list"),
  reorderDownload: (jobId, direction) =>
    ipcRenderer.invoke("downloads:reorder", jobId, direction),
  pauseAllDownloads: () => ipcRenderer.invoke("downloads:pause-all"),
  getDiagnostics: () => ipcRenderer.invoke("diagnostics:get"),
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export"),
  clearPrivateData: () => ipcRenderer.invoke("privacy:clear-data"),
  getRecoverableFiles: () => ipcRenderer.invoke("recovery:list"),
  removeRecoverableFile: (path) => ipcRenderer.invoke("recovery:remove", path),
  retryRecoverableFile: (path) => ipcRenderer.invoke("recovery:retry", path),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  showFile: (filePath) => ipcRenderer.invoke("file:show", filePath),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  onDetected: (callback) =>
    ipcRenderer.on("media:detected", (_event, data) => callback(data)),
  onDownloadStarted: (callback) =>
    ipcRenderer.on("download:started", (_event, data) => callback(data)),
  onDownloadQueued: (callback) =>
    ipcRenderer.on("download:queued", (_event, data) => callback(data)),
  onDownloadFinished: (callback) =>
    ipcRenderer.on("download:finished", (_event, data) => callback(data)),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("download:progress", (_event, data) => callback(data)),
  onClipboardSuggestion: (callback) =>
    ipcRenderer.on("clipboard:suggestion", (_event, data) => callback(data)),
  onUpdateStatus: (callback) =>
    ipcRenderer.on("update:status", (_event, data) => callback(data)),
  onNotice: (callback) =>
    ipcRenderer.on("app:notice", (_event, data) => callback(data)),
});
