"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const ffmpegPath = require("ffmpeg-static");
const { unpackedBinaryPath } = require("./binary-path");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell
} = require("electron");
const { isBlockedHost, parseHttpUrl } = require("./policy");
const { resolvePublicPage } = require("./page-resolver");
const {
  createAnonymousDouyinSession,
  isDouyinVideoUrl
} = require("./douyin-session");
const {
  DEFAULT_BRIDGE_PORT,
  startCaptureBridge
} = require("./capture-bridge");

const MEDIA_PARTITION = "persist:media-scout";
const DEFAULT_START_URL = "https://archive.org/";
let mainWindow;
let captureBridge;
let captureBridgeRetryTimer;
let appClosing = false;
let lastPageHost = "";
let downloadDirectory = "";
let alwaysOnTop = false;
let downloadRightsConfirmed = false;
const detectedUrls = new Set();
const detectedKeys = new Set();
const previewConversions = new Map();
const ytDlpPath = unpackedBinaryPath(
  path.join(
    path.dirname(require.resolve("@distube/yt-dlp")),
    "..",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  )
);

app.setAppUserModelId("com.independent.mediascout");

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  downloadDirectory = app.getPath("downloads");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (
      typeof settings.downloadDirectory === "string" &&
      fs.existsSync(settings.downloadDirectory)
    ) {
      downloadDirectory = settings.downloadDirectory;
    }
    alwaysOnTop = settings.alwaysOnTop === true;
    downloadRightsConfirmed = settings.downloadRightsConfirmed === true;
  } catch {
    // First launch or an unreadable settings file falls back to Downloads.
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        alwaysOnTop,
        downloadDirectory,
        downloadRightsConfirmed
      },
      null,
      2
    ),
    "utf8"
  );
}

function availableDownloadPath(filename) {
  const safeFilename = path.basename(filename);
  const parsed = path.parse(safeFilename);
  let candidate = path.join(downloadDirectory, safeFilename);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadDirectory, `${parsed.name} (${suffix})${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function downloadFilename(title = "") {
  const safeTitle = String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${safeTitle || "Media Scout video"}.mp4`;
}

function mergeMediaDownload(videoUrl, audioUrl, title = "") {
  const outputPath = availableDownloadPath(downloadFilename(title));
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working`;
  const filename = path.basename(outputPath);
  send("download:started", { filename, url: videoUrl });
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      ffmpegPath,
      [
        "-y",
        "-i", videoUrl,
        "-i", audioUrl,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "160k",
        "-shortest",
        "-movflags", "+faststart",
        "-f", "mp4",
        temporaryPath
      ],
      { windowsHide: true }
    );
    const finish = (state) => {
      if (settled) return;
      settled = true;
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: videoUrl
      });
      resolve({ ok: state === "completed" });
    };
    child.once("error", () => {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      finish("interrupted");
    });
    child.once("exit", (code) => {
      if (code !== 0 || !fs.existsSync(temporaryPath)) {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
        return;
      }
      try {
        fs.renameSync(temporaryPath, outputPath);
        finish("completed");
      } catch {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
      }
    });
  });
}

function downloadYouTubePage(pageUrl, title, sourceUrl) {
  const outputPath = availableDownloadPath(downloadFilename(title));
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working.mp4`;
  const filename = path.basename(outputPath);
  let settled = false;
  send("download:started", { filename, url: sourceUrl });
  return new Promise((resolve) => {
    const child = spawn(
      ytDlpPath,
      [
        "--no-playlist",
        "--no-warnings",
        "--force-overwrites",
        "--format",
        "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/" +
          "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--ffmpeg-location", path.dirname(unpackedBinaryPath(ffmpegPath)),
        "--merge-output-format", "mp4",
        "--output", temporaryPath,
        pageUrl
      ],
      { windowsHide: true }
    );
    const finish = (state) => {
      if (settled) return;
      settled = true;
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: sourceUrl
      });
      resolve({ ok: state === "completed" });
    };
    child.once("error", () => finish("interrupted"));
    child.once("exit", (code) => {
      if (code !== 0 || !fs.existsSync(temporaryPath)) {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
        return;
      }
      try {
        fs.renameSync(temporaryPath, outputPath);
        finish("completed");
      } catch {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
      }
    });
  });
}

async function downloadDouyinPage(pageUrl, title, sourceUrl) {
  let douyinSession;
  try {
    douyinSession = await createAnonymousDouyinSession(pageUrl);
  } catch {
    return { ok: false, message: "Could not start a public Douyin session." };
  }
  const outputPath = availableDownloadPath(downloadFilename(title));
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working.mp4`;
  const filename = path.basename(outputPath);
  let settled = false;
  send("download:started", { filename, url: sourceUrl });

  return new Promise((resolve) => {
    const child = spawn(
      ytDlpPath,
      [
        "--no-playlist",
        "--no-warnings",
        "--force-overwrites",
        "--cookies", douyinSession.cookieFile,
        "--format", "best[vcodec^=h264]/best[vcodec^=avc]/best",
        "--output", temporaryPath,
        pageUrl
      ],
      { windowsHide: true }
    );
    const finish = (state) => {
      if (settled) return;
      settled = true;
      douyinSession.dispose();
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: sourceUrl
      });
      resolve({ ok: state === "completed" });
    };
    child.once("error", () => finish("interrupted"));
    child.once("exit", (code) => {
      if (code !== 0 || !fs.existsSync(temporaryPath)) {
        fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
        return;
      }
      try {
        fs.renameSync(temporaryPath, outputPath);
        finish("completed");
      } catch {
        fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
      }
    });
  });
}

function compatiblePreviewPath(url, audioUrl = "") {
  const name = crypto
    .createHash("sha256")
    .update(`${url}\n${audioUrl}`)
    .digest("hex")
    .slice(0, 24);
  const directory = path.join(app.getPath("temp"), "media-scout-previews");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${name}.mp4`);
}

function transcodePreview(url, audioUrl = "") {
  const outputPath = compatiblePreviewPath(url, audioUrl);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return Promise.resolve({ ok: true, url: pathToFileURL(outputPath).href });
  }
  if (previewConversions.has(outputPath)) {
    return previewConversions.get(outputPath);
  }
  const conversion = new Promise((resolve) => {
    const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working`;
    const inputArguments = ["-i", url];
    if (audioUrl) inputArguments.push("-i", audioUrl);
    const child = spawn(
      ffmpegPath,
      [
        "-y",
        ...inputArguments,
        "-map", "0:v:0?",
        "-map", audioUrl ? "1:a:0?" : "0:a:0?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        "-f", "mp4",
        temporaryPath
      ],
      { windowsHide: true }
    );
    const timeout = setTimeout(() => child.kill(), 180_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, message: "The compatible preview converter could not start." });
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(temporaryPath)) {
        try {
          if (fs.existsSync(outputPath)) {
            fs.rmSync(temporaryPath, { force: true });
          } else {
            fs.renameSync(temporaryPath, outputPath);
          }
          resolve({ ok: true, url: pathToFileURL(outputPath).href });
        } catch {
          if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
          resolve({ ok: false, message: "Preview unavailable. You can still save the media." });
        }
        return;
      }
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      resolve({ ok: false, message: "This Douyin video could not be converted for preview." });
    });
  });
  previewConversions.set(outputPath, conversion);
  conversion.finally(() => previewConversions.delete(outputPath));
  return conversion;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function mediaKey(url) {
  const parsed = parseHttpUrl(url);
  return parsed ? `${parsed.hostname.toLowerCase()}${parsed.pathname}` : url;
}

function addDetectedMedia(media) {
  const key =
    media.source === "Public page resolver" && media.pageUrl
      ? `page:${media.pageUrl}`
      : mediaKey(media.url);
  if (detectedKeys.has(key)) return false;
  detectedKeys.add(key);
  detectedUrls.add(media.url);
  if (media.analysis?.audioUrl) detectedUrls.add(media.analysis.audioUrl);
  for (const variant of media.variants || []) {
    if (variant.url) detectedUrls.add(variant.url);
  }
  send("media:detected", media);
  return true;
}

async function resolveAndCapture(rawUrl, source = "Public page resolver") {
  let douyinSession = null;
  let resolved;
  try {
    if (isDouyinVideoUrl(rawUrl)) {
      douyinSession = await createAnonymousDouyinSession(rawUrl);
    }
    resolved = await resolvePublicPage(rawUrl, {
      cookieFile: douyinSession?.cookieFile
    });
  } finally {
    douyinSession?.dispose();
  }
  if (!resolved.ok) return resolved;
  let added = 0;
  for (const url of resolved.candidates) {
    const parsed = parseHttpUrl(url);
    if (!parsed || isBlockedHost(parsed.hostname)) continue;
    const analysis = resolved.analysis
      ? {
          ...resolved.analysis,
          audioUrl:
            resolved.analysis.audioUrl || resolved.analysis.audioSourceUrl || ""
        }
      : null;
    if (analysis) delete analysis.audioSourceUrl;
    if (addDetectedMedia({
      allowed: true,
      analysis,
      detectedAt: new Date().toISOString(),
      extension: ".mp4",
      hostname: parsed.hostname,
      mime: "video/mp4",
      pageHost: new URL(resolved.pageUrl).hostname,
      pageUrl: resolved.pageUrl,
      size: resolved.candidateSizes?.[parsed.href] || 0,
      source,
      thumbnail: resolved.thumbnail || "",
      title: resolved.title || "",
      variants: resolved.variants || [],
      url: parsed.href
    })) added += 1;
  }
  return { added, ok: true };
}

function configureMediaSession() {
  const mediaSession = session.fromPartition(MEDIA_PARTITION);

  mediaSession.webRequest.onBeforeRequest((details, callback) => {
    const parsed = parseHttpUrl(details.url);
    if (parsed && isBlockedHost(parsed.hostname)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  mediaSession.on("will-download", (_event, item) => {
    item.setSavePath(availableDownloadPath(item.getFilename()));
    send("download:started", {
      filename: item.getFilename(),
      url: item.getURL()
    });

    item.once("done", (_downloadEvent, state) => {
      send("download:finished", {
        filename: item.getFilename(),
        path: item.getSavePath(),
        state,
        url: item.getURL()
      });
    });

    item.on("updated", (_downloadEvent, state) => {
      const totalBytes = item.getTotalBytes();
      const receivedBytes = item.getReceivedBytes();
      send("download:progress", {
        filename: item.getFilename(),
        receivedBytes,
        state,
        totalBytes,
        url: item.getURL()
      });
    });
  });
}

function launchCaptureBridge() {
  clearTimeout(captureBridgeRetryTimer);
  captureBridge = startCaptureBridge(
    (media) => addDetectedMedia(media),
    DEFAULT_BRIDGE_PORT,
    async (pageUrl) => {
      if (!isDouyinVideoUrl(pageUrl)) return {};
      const douyinSession = await createAnonymousDouyinSession(pageUrl);
      return {
        cookieFile: douyinSession.cookieFile,
        dispose: () => douyinSession.dispose()
      };
    }
  );
  captureBridge.once("error", () => {
    captureBridge = null;
    if (!appClosing) {
      captureBridgeRetryTimer = setTimeout(launchCaptureBridge, 1_500);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 690,
    minWidth: 720,
    minHeight: 520,
    center: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    title: "Media Scout",
    icon: path.join(__dirname, "assets", "media-scout-logo.png"),
    backgroundColor: "#171316",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: MEDIA_PARTITION
    }
  });
  mainWindow.setAlwaysOnTop(alwaysOnTop);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  const capturePath = process.env.MEDIA_SCOUT_CAPTURE_PATH;
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        if (process.env.MEDIA_SCOUT_START_URL) {
          await resolveAndCapture(process.env.MEDIA_SCOUT_START_URL);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!process.env.MEDIA_SCOUT_START_URL) {
          const sampleUrl =
            "https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4";
          detectedUrls.add(sampleUrl);
          detectedKeys.add(mediaKey(sampleUrl));
          send("media:detected", {
            allowed: true,
            detectedAt: new Date().toISOString(),
            extension: ".mp4",
            hostname: "archive.org",
            mime: "video/mp4",
            pageHost: "archive.org",
            size: 47_382_528,
            url: sampleUrl
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (process.env.MEDIA_SCOUT_CAPTURE_LIST === "yes") {
          for (let index = 1; index <= 12; index += 1) {
            const sampleUrl = `http://127.0.0.1/local-video-${index}.mp4`;
            detectedUrls.add(sampleUrl);
            detectedKeys.add(mediaKey(sampleUrl));
            send("media:detected", {
              allowed: true,
              detectedAt: new Date().toISOString(),
              extension: ".mp4",
              hostname: "127.0.0.1",
              mime: "video/mp4",
              pageHost: "Local layout test",
              size: index * 1_048_576,
              url: sampleUrl
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        if (process.env.MEDIA_SCOUT_CAPTURE_PREVIEW !== "no") {
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('.preview-button')?.click()"
          );
        }
        if (process.env.MEDIA_SCOUT_CAPTURE_VIEW) {
          const view = JSON.stringify(process.env.MEDIA_SCOUT_CAPTURE_VIEW);
          await mainWindow.webContents.executeJavaScript(
            `document.querySelector('[data-view=' + ${view} + ']')?.click()`
          );
        }
        if (process.env.MEDIA_SCOUT_CAPTURE_RIGHTS === "yes") {
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('#rightsDialog')?.showModal()"
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 850));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(capturePath, image.toPNG());
        app.quit();
      }, process.env.MEDIA_SCOUT_START_URL ? 9_000 : 1_600);
    });
  }
}

app.whenReady().then(() => {
  loadSettings();
  configureMediaSession();
  launchCaptureBridge();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  appClosing = true;
  clearTimeout(captureBridgeRetryTimer);
  if (captureBridge) captureBridge.close();
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("navigation:validate", (_event, rawUrl) => {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return { ok: false, message: "Enter a valid http:// or https:// address." };
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, message: "This provider is excluded by Media Scout policy." };
  }
  lastPageHost = parsed.hostname;
  return { ok: true, url: parsed.href };
});

ipcMain.handle("app:get-config", () => ({
  extensionPath: path.resolve(__dirname, "..", "browser-extension"),
  startUrl: process.env.MEDIA_SCOUT_START_URL || DEFAULT_START_URL,
  downloadDirectory,
  alwaysOnTop,
  downloadRightsConfirmed
}));

ipcMain.handle("settings:confirm-download-rights", () => {
  downloadRightsConfirmed = true;
  saveSettings();
  return { ok: true };
});

ipcMain.handle("window:toggle-always-on-top", () => {
  alwaysOnTop = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(alwaysOnTop);
  saveSettings();
  return { alwaysOnTop, ok: true };
});

ipcMain.handle("window:minimize", () => {
  mainWindow.minimize();
});

ipcMain.handle("window:toggle-maximize", () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { maximized: mainWindow.isMaximized() };
});

ipcMain.handle("window:close", () => {
  mainWindow.close();
});

ipcMain.handle("settings:choose-download-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: downloadDirectory,
    properties: ["openDirectory", "createDirectory"],
    title: "Choose download location"
  });
  if (result.canceled || !result.filePaths[0]) {
    return { cancelled: true, ok: false };
  }
  downloadDirectory = result.filePaths[0];
  saveSettings();
  return { downloadDirectory, ok: true };
});

ipcMain.handle("extension:copy-path", () => {
  const extensionPath = path.resolve(__dirname, "..", "browser-extension");
  clipboard.writeText(extensionPath);
  return { ok: true };
});

ipcMain.handle("extension:show-folder", () => {
  const extensionPath = path.resolve(__dirname, "..", "browser-extension");
  shell.openPath(extensionPath);
  return { ok: true };
});

ipcMain.handle("page:resolve", async (_event, rawUrl) => {
  return resolveAndCapture(rawUrl);
});

ipcMain.handle("media:copy", (_event, url) => {
  const parsed = parseHttpUrl(url);
  if (!parsed || isBlockedHost(parsed.hostname) || !detectedUrls.has(parsed.href)) {
    return { ok: false, message: "This link is not an approved detected media request." };
  }
  clipboard.writeText(parsed.href);
  return { ok: true };
});

ipcMain.handle("media:download", async (
  _event,
  url,
  audioUrl = "",
  title = "",
  pageUrl = ""
) => {
  const parsed = parseHttpUrl(url);
  const parsedAudio = audioUrl ? parseHttpUrl(audioUrl) : null;
  if (!parsed || isBlockedHost(parsed.hostname) || !detectedUrls.has(parsed.href)) {
    return { ok: false, message: "This link is not an approved detected media request." };
  }
  if (audioUrl && (!parsedAudio || !detectedUrls.has(parsedAudio.href))) {
    return { ok: false, message: "The detected audio track is unavailable." };
  }

  if (!downloadRightsConfirmed) {
    return { ok: false, needsPermission: true };
  }
  const parsedPage = parseHttpUrl(pageUrl);
  if (
    parsedPage &&
    ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
      parsedPage.hostname.toLowerCase()
    )
  ) {
    return downloadYouTubePage(parsedPage.href, title, parsed.href);
  }
  if (parsedPage && isDouyinVideoUrl(parsedPage.href)) {
    return downloadDouyinPage(parsedPage.href, title, parsed.href);
  }
  if (parsedAudio) {
    return mergeMediaDownload(parsed.href, parsedAudio.href, title);
  }
  session.fromPartition(MEDIA_PARTITION).downloadURL(parsed.href);
  return { ok: true };
});

ipcMain.handle("media:compatible-preview", async (_event, url, audioUrl = "") => {
  const parsed = parseHttpUrl(url);
  const parsedAudio = audioUrl ? parseHttpUrl(audioUrl) : null;
  if (!parsed || !detectedUrls.has(parsed.href)) {
    return { ok: false, message: "This is not an approved detected media request." };
  }
  if (audioUrl && (!parsedAudio || !detectedUrls.has(parsedAudio.href))) {
    return { ok: false, message: "The detected audio track is unavailable." };
  }
  return transcodePreview(parsed.href, parsedAudio?.href || "");
});

ipcMain.handle("media:open-browser", (_event, url) => {
  const parsed = parseHttpUrl(url);
  if (!parsed || isBlockedHost(parsed.hostname) || !detectedUrls.has(parsed.href)) {
    return { ok: false, message: "This link is not an approved detected media request." };
  }
  if (!captureBridge) return { ok: false, message: "The browser bridge is unavailable." };
  captureBridge.enqueueCommand({
    createdAt: Date.now(),
    type: "open-media",
    url: parsed.href
  });
  return { ok: true };
});

ipcMain.handle("media:clear", () => {
  detectedUrls.clear();
  detectedKeys.clear();
  return { ok: true };
});

ipcMain.handle("file:show", (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});
