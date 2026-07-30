"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaScout", {
  getConfig: () => ipcRenderer.invoke("app:get-config"),
  chooseDownloadDirectory: () =>
    ipcRenderer.invoke("settings:choose-download-directory"),
  copyExtensionPath: () => ipcRenderer.invoke("extension:copy-path"),
  showExtensionFolder: () => ipcRenderer.invoke("extension:show-folder"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  confirmDownloadRights: () =>
    ipcRenderer.invoke("settings:confirm-download-rights"),
  validateNavigation: (url) => ipcRenderer.invoke("navigation:validate", url),
  resolvePage: (url) => ipcRenderer.invoke("page:resolve", url),
  copyMedia: (url) => ipcRenderer.invoke("media:copy", url),
  downloadMedia: (url, audioUrl, title, pageUrl) =>
    ipcRenderer.invoke("media:download", url, audioUrl, title, pageUrl),
  prepareCompatiblePreview: (url, audioUrl) =>
    ipcRenderer.invoke("media:compatible-preview", url, audioUrl),
  openInBrowser: (url) => ipcRenderer.invoke("media:open-browser", url),
  clearMedia: () => ipcRenderer.invoke("media:clear"),
  showFile: (filePath) => ipcRenderer.invoke("file:show", filePath),
  onDetected: (callback) =>
    ipcRenderer.on("media:detected", (_event, data) => callback(data)),
  onDownloadStarted: (callback) =>
    ipcRenderer.on("download:started", (_event, data) => callback(data)),
  onDownloadFinished: (callback) =>
    ipcRenderer.on("download:finished", (_event, data) => callback(data)),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("download:progress", (_event, data) => callback(data)),
});
