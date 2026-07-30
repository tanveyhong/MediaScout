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
  Notification,
  safeStorage,
  session,
  shell,
} = require("electron");
const { AppData } = require("./app-data");
const { configureUpdates } = require("./update-service");
const { parseHttpUrl } = require("./policy");
const { normalizePublicPage, resolvePublicPage } = require("./page-resolver");
const {
  createAnonymousDouyinSession,
  isDouyinVideoUrl,
} = require("./douyin-session");
const { DEFAULT_BRIDGE_PORT, startCaptureBridge } = require("./capture-bridge");

const MEDIA_PARTITION = "persist:media-scout";
const DEFAULT_START_URL = "https://archive.org/";
let pairingCode = "";
let encryptedPairingCode = "";
let mainWindow;
let captureBridge;
let captureBridgeRetryTimer;
let appClosing = false;
let downloadDirectory = "";
let alwaysOnTop = false;
let downloadRightsConfirmed = false;
let appData;
let clipboardTimer;
let updater;
let lastClipboardText = "";
const DEFAULT_PREFERENCES = Object.freeze({
  audioOnly: false,
  clipboardMonitoring: false,
  maxHeight: 0,
  maxFileSizeMb: 0,
  nativeNotifications: true,
  preferH264: true,
});
let preferences = { ...DEFAULT_PREFERENCES };
let lastResolverError = "";
const recoverableFiles = [];
const completedDownloadPaths = new Set();
const activeChildren = new Set();
const activeDownloadHandles = new Map();
const downloadQueue = [];
let runningQueuedDownloads = 0;
const pendingDownloadMetadata = new Map();
const detectedUrls = new Set();
const detectedKeys = new Set();
const previewConversions = new Map();
const ytDlpPath = unpackedBinaryPath(
  path.join(
    path.dirname(require.resolve("@distube/yt-dlp")),
    "..",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  ),
);

app.setAppUserModelId("com.independent.mediascout");

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function extensionDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "browser-extension")
    : path.resolve(__dirname, "..", "browser-extension");
}

function loadSettings() {
  downloadDirectory = app.getPath("downloads");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (
      typeof settings.downloadDirectory === "string" &&
      fs.existsSync(settings.downloadDirectory)
    ) {
      downloadDirectory = settings.downloadDirectory;
    }
    alwaysOnTop = settings.alwaysOnTop === true;
    preferences = { ...preferences, ...(settings.preferences || {}) };
  } catch {
    // First launch or an unreadable settings file falls back to Downloads.
  }
  if (
    safeStorage.isEncryptionAvailable() &&
    typeof settings.encryptedPairingCode === "string"
  ) {
    try {
      const savedCode = safeStorage.decryptString(
        Buffer.from(settings.encryptedPairingCode, "base64"),
      );
      if (/^\d{6}$/.test(savedCode)) pairingCode = savedCode;
    } catch {
      // A credential from another OS account or installation is replaced below.
    }
  }
  if (!pairingCode) {
    pairingCode = crypto.randomInt(100_000, 1_000_000).toString();
  }
  encryptedPairingCode = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(pairingCode).toString("base64")
    : "";
  saveSettings();
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        alwaysOnTop,
        downloadDirectory,
        downloadRightsConfirmed: false,
        encryptedPairingCode,
        preferences,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function finishHistory({
  filename,
  outputPath,
  pageUrl = "",
  size = 0,
  sourceUrl = "",
  state,
  title = "",
}) {
  appData?.addHistory({
    completedAt: new Date().toISOString(),
    filename,
    id: crypto.randomUUID(),
    pageUrl,
    path: state === "completed" ? outputPath : "",
    size,
    sourceUrl,
    state,
    title,
  });
  appData?.log(state === "completed" ? "info" : "error", "download-finished", {
    filename,
    state,
  });
  if (preferences.nativeNotifications && Notification.isSupported()) {
    new Notification({
      body:
        state === "completed"
          ? `${filename} was saved successfully.`
          : `${filename} could not be saved.`,
      title: state === "completed" ? "Download complete" : "Download failed",
    }).show();
  }
}

function availableDownloadPath(filename) {
  const safeFilename = path.basename(filename);
  const parsed = path.parse(safeFilename);
  let candidate = path.join(downloadDirectory, safeFilename);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(
      downloadDirectory,
      `${parsed.name} (${suffix})${parsed.ext}`,
    );
    suffix += 1;
  }
  return candidate;
}

function downloadFilename(title = "", extension = ".mp4") {
  const safeTitle = String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${safeTitle || "Media Scout media"}${extension}`;
}

function enqueueDownload(url, task) {
  const job = { id: crypto.randomUUID(), task, url };
  downloadQueue.push(job);
  send("download:queued", {
    id: job.id,
    position: downloadQueue.length,
    url,
  });
  pumpDownloadQueue();
  return { jobId: job.id, ok: true, queued: true };
}

function pumpDownloadQueue() {
  while (runningQueuedDownloads < 2 && downloadQueue.length) {
    const job = downloadQueue.shift();
    runningQueuedDownloads += 1;
    Promise.resolve()
      .then(job.task)
      .catch((error) => {
        appData?.log("error", "queued-download-failed", {
          message: error.message,
        });
        send("download:finished", {
          filename: "",
          path: "",
          state: "interrupted",
          url: job.url,
        });
      })
      .finally(() => {
        runningQueuedDownloads -= 1;
        pumpDownloadQueue();
      });
  }
}

function emitExtractorProgress(child, url) {
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      const match = line.match(
        /MEDIA_SCOUT_PROGRESS:([\d.]+)%\|([^|]*)\|([^|]*)/,
      );
      if (!match) continue;
      send("download:progress", {
        eta: match[3].trim(),
        percent: Number(match[1]),
        speed: match[2].trim(),
        state: "progressing",
        url,
      });
    }
  });
}

function youtubeFormat() {
  if (preferences.audioOnly) return "ba/b";
  const height = preferences.maxHeight
    ? `[height<=${Number(preferences.maxHeight)}]`
    : "";
  const codec = preferences.preferH264 ? "[vcodec^=avc1]" : "";
  return (
    `bv*[ext=mp4]${codec}${height}+ba[ext=m4a]/` +
    `bv*[ext=mp4]${height}+ba[ext=m4a]/b[ext=mp4]${height}/b`
  );
}

function trackedSpawn(command, args, options) {
  const child = spawn(command, args, options);
  activeChildren.add(child);
  child.once("close", (code) => {
    activeChildren.delete(child);
    if (code && !appClosing) {
      const details = {
        command: path.basename(command),
        exitCode: code,
      };
      console.error("[media-scout] child process failed", details);
      appData?.log("error", "child-process-failed", details);
    }
  });
  return child;
}

function cleanupTemporaryFiles() {
  const now = Date.now();
  const targets = [
    {
      directory: app.getPath("temp"),
      maxAge: 24 * 60 * 60 * 1000,
      pattern: /\.working(?:\.(?:mp3|mp4))?$/,
    },
    {
      directory: downloadDirectory,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      pattern: /\.working(?:\.(?:mp3|mp4))?$/,
    },
    {
      directory: path.join(app.getPath("temp"), "media-scout-previews"),
      maxAge: 7 * 24 * 60 * 60 * 1000,
      pattern: /\.mp4$/,
    },
  ];
  for (const target of targets) {
    if (!fs.existsSync(target.directory)) continue;
    for (const entry of fs.readdirSync(target.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !target.pattern.test(entry.name)) continue;
      const filePath = path.join(target.directory, entry.name);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > target.maxAge) {
          fs.rmSync(filePath, { force: true });
          fs.rmSync(`${filePath}.json`, { force: true });
        } else if (/\.working(?:\.(?:mp3|mp4))?$/.test(entry.name)) {
          let metadata = {};
          try {
            metadata = JSON.parse(fs.readFileSync(`${filePath}.json`, "utf8"));
          } catch {
            metadata = {};
          }
          recoverableFiles.push({
            ...metadata,
            modifiedAt: stats.mtime.toISOString(),
            name: entry.name,
            path: filePath,
          });
        }
      } catch (error) {
        console.error("[media-scout] temporary file cleanup failed", {
          file: entry.name,
          message: error.message,
        });
      }
    }
  }
}

function registerRecovery(temporaryPath, metadata) {
  fs.writeFileSync(
    `${temporaryPath}.json`,
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

function clearRecovery(temporaryPath) {
  fs.rmSync(`${temporaryPath}.json`, { force: true });
}

function mergeMediaDownload(videoUrl, audioUrl, title = "", pageUrl = "") {
  const outputPath = availableDownloadPath(downloadFilename(title));
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working`;
  const filename = path.basename(outputPath);
  registerRecovery(temporaryPath, { pageUrl, sourceUrl: videoUrl, title });
  send("download:started", { filename, url: videoUrl });
  return new Promise((resolve) => {
    let settled = false;
    const child = trackedSpawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        videoUrl,
        "-i",
        audioUrl,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporaryPath,
      ],
      { windowsHide: true },
    );
    activeDownloadHandles.set(videoUrl, child);
    send("download:progress", {
      percent: 0,
      phase: "Merging video and audio",
      state: "progressing",
      url: videoUrl,
    });
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearRecovery(temporaryPath);
      activeDownloadHandles.delete(videoUrl);
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: videoUrl,
      });
      if (state === "completed")
        completedDownloadPaths.add(path.resolve(outputPath));
      finishHistory({
        filename,
        outputPath,
        sourceUrl: videoUrl,
        state,
        title,
      });
      resolve({ ok: state === "completed" });
    };
    child.once("error", () => {
      if (fs.existsSync(temporaryPath))
        fs.rmSync(temporaryPath, { force: true });
      finish("interrupted");
    });
    child.once("exit", (code) => {
      if (code !== 0 || !fs.existsSync(temporaryPath)) {
        if (fs.existsSync(temporaryPath))
          fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
        return;
      }
      try {
        fs.renameSync(temporaryPath, outputPath);
        finish("completed");
      } catch {
        if (fs.existsSync(temporaryPath))
          fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
      }
    });
  });
}

function downloadYouTubePage(pageUrl, title, sourceUrl) {
  const extension = preferences.audioOnly ? ".mp3" : ".mp4";
  const outputPath = availableDownloadPath(downloadFilename(title, extension));
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.working${extension}`;
  const filename = path.basename(outputPath);
  registerRecovery(temporaryPath, { pageUrl, sourceUrl, title });
  let settled = false;
  send("download:started", { filename, url: sourceUrl });
  return new Promise((resolve) => {
    const child = trackedSpawn(
      ytDlpPath,
      [
        "--no-playlist",
        "--no-warnings",
        "--force-overwrites",
        "--newline",
        "--progress-template",
        "MEDIA_SCOUT_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--format",
        youtubeFormat(),
        "--ffmpeg-location",
        path.dirname(unpackedBinaryPath(ffmpegPath)),
        ...(preferences.audioOnly
          ? ["--extract-audio", "--audio-format", "mp3"]
          : ["--merge-output-format", "mp4"]),
        "--output",
        temporaryPath,
        pageUrl,
      ],
      { windowsHide: true },
    );
    activeDownloadHandles.set(sourceUrl, child);
    emitExtractorProgress(child, sourceUrl);
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearRecovery(temporaryPath);
      activeDownloadHandles.delete(sourceUrl);
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: sourceUrl,
      });
      if (state === "completed")
        completedDownloadPaths.add(path.resolve(outputPath));
      finishHistory({
        filename,
        outputPath,
        pageUrl,
        sourceUrl,
        state,
        title,
      });
      resolve({ ok: state === "completed" });
    };
    child.once("error", () => finish("interrupted"));
    child.once("exit", (code) => {
      if (code !== 0 || !fs.existsSync(temporaryPath)) {
        if (fs.existsSync(temporaryPath))
          fs.rmSync(temporaryPath, { force: true });
        finish("interrupted");
        return;
      }
      try {
        fs.renameSync(temporaryPath, outputPath);
        finish("completed");
      } catch {
        if (fs.existsSync(temporaryPath))
          fs.rmSync(temporaryPath, { force: true });
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
  registerRecovery(temporaryPath, { pageUrl, sourceUrl, title });
  let settled = false;
  send("download:started", { filename, url: sourceUrl });

  return new Promise((resolve) => {
    const child = trackedSpawn(
      ytDlpPath,
      [
        "--no-playlist",
        "--no-warnings",
        "--force-overwrites",
        "--newline",
        "--progress-template",
        "MEDIA_SCOUT_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--cookies",
        douyinSession.cookieFile,
        "--format",
        "best[vcodec^=h264]/best[vcodec^=avc]/best",
        "--output",
        temporaryPath,
        pageUrl,
      ],
      { windowsHide: true },
    );
    activeDownloadHandles.set(sourceUrl, child);
    emitExtractorProgress(child, sourceUrl);
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearRecovery(temporaryPath);
      activeDownloadHandles.delete(sourceUrl);
      douyinSession.dispose();
      send("download:finished", {
        filename,
        path: state === "completed" ? outputPath : "",
        state,
        url: sourceUrl,
      });
      if (state === "completed")
        completedDownloadPaths.add(path.resolve(outputPath));
      finishHistory({
        filename,
        outputPath,
        pageUrl,
        sourceUrl,
        state,
        title,
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
    const child = trackedSpawn(
      ffmpegPath,
      [
        "-y",
        ...inputArguments,
        "-map",
        "0:v:0?",
        "-map",
        audioUrl ? "1:a:0?" : "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporaryPath,
      ],
      { windowsHide: true },
    );
    const timeout = setTimeout(() => child.kill(), 180_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        message: "The compatible preview converter could not start.",
      });
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
          if (fs.existsSync(temporaryPath))
            fs.rmSync(temporaryPath, { force: true });
          resolve({
            ok: false,
            message: "Preview unavailable. You can still save the media.",
          });
        }
        return;
      }
      if (fs.existsSync(temporaryPath))
        fs.rmSync(temporaryPath, { force: true });
      resolve({
        ok: false,
        message: "This Douyin video could not be converted for preview.",
      });
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
      cookieFile: douyinSession?.cookieFile,
    });
  } finally {
    douyinSession?.dispose();
  }
  if (!resolved.ok) {
    lastResolverError = resolved.reason || "Unknown resolver error.";
    appData?.log("error", "resolve-failed", {
      reason: lastResolverError,
      url: rawUrl,
    });
    return resolved;
  }
  lastResolverError = "";
  let added = 0;
  for (const url of resolved.candidates) {
    const parsed = parseHttpUrl(url);
    if (!parsed) continue;
    const analysis = resolved.analysis
      ? {
          ...resolved.analysis,
          audioUrl:
            resolved.analysis.audioUrl ||
            resolved.analysis.audioSourceUrl ||
            "",
        }
      : null;
    if (analysis) delete analysis.audioSourceUrl;
    if (
      addDetectedMedia({
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
        url: parsed.href,
      })
    )
      added += 1;
  }
  return { added, ok: true };
}

function configureMediaSession() {
  const mediaSession = session.fromPartition(MEDIA_PARTITION);

  mediaSession.on("will-download", (_event, item) => {
    activeDownloadHandles.set(item.getURL(), item);
    item.setSavePath(availableDownloadPath(item.getFilename()));
    send("download:started", {
      filename: item.getFilename(),
      url: item.getURL(),
    });

    item.once("done", (_downloadEvent, state) => {
      activeDownloadHandles.delete(item.getURL());
      const metadata = pendingDownloadMetadata.get(item.getURL()) || {};
      pendingDownloadMetadata.delete(item.getURL());
      if (state === "completed") {
        completedDownloadPaths.add(path.resolve(item.getSavePath()));
      }
      finishHistory({
        filename: item.getFilename(),
        outputPath: item.getSavePath(),
        pageUrl: metadata.pageUrl,
        size: item.getReceivedBytes(),
        sourceUrl: item.getURL(),
        state,
        title: metadata.title,
      });
      send("download:finished", {
        filename: item.getFilename(),
        path: item.getSavePath(),
        state,
        url: item.getURL(),
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
        url: item.getURL(),
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
        dispose: () => douyinSession.dispose(),
      };
    },
    { pairingCode },
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
      sandbox: true,
      partition: MEDIA_PARTITION,
    },
  });
  mainWindow.setAlwaysOnTop(alwaysOnTop);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  const capturePath = process.env.MEDIA_SCOUT_CAPTURE_PATH;
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(
        async () => {
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
              url: sampleUrl,
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
                url: sampleUrl,
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
          if (process.env.MEDIA_SCOUT_CAPTURE_PREVIEW !== "no") {
            await mainWindow.webContents.executeJavaScript(
              "document.querySelector('.preview-button')?.click()",
            );
          }
          if (process.env.MEDIA_SCOUT_CAPTURE_VIEW) {
            const view = JSON.stringify(process.env.MEDIA_SCOUT_CAPTURE_VIEW);
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('[data-view=' + ${view} + ']')?.click()`,
            );
          }
          if (process.env.MEDIA_SCOUT_CAPTURE_RIGHTS === "yes") {
            await mainWindow.webContents.executeJavaScript(
              "document.querySelector('#rightsDialog')?.showModal()",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 850));
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(capturePath, image.toPNG());
          app.quit();
        },
        process.env.MEDIA_SCOUT_START_URL ? 9_000 : 1_600,
      );
    });
  }
}

app.whenReady().then(() => {
  appData = new AppData(app.getPath("userData"));
  for (const entry of appData.getHistory()) {
    if (
      entry.state === "completed" &&
      entry.path &&
      fs.existsSync(entry.path)
    ) {
      completedDownloadPaths.add(path.resolve(entry.path));
    }
  }
  loadSettings();
  cleanupTemporaryFiles();
  configureMediaSession();
  launchCaptureBridge();
  createWindow();
  updater = configureUpdates(send, (...args) => appData.log(...args));
  if (app.isPackaged) {
    setTimeout(() => updater.checkForUpdates().catch(() => {}), 4_000);
  }
  clipboardTimer = setInterval(() => {
    if (!preferences.clipboardMonitoring) return;
    const value = clipboard.readText().trim();
    if (!value || value === lastClipboardText) return;
    lastClipboardText = value;
    const supportedUrl = normalizePublicPage(value);
    if (supportedUrl) send("clipboard:suggestion", { url: supportedUrl });
  }, 1_500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  appClosing = true;
  clearTimeout(captureBridgeRetryTimer);
  clearInterval(clipboardTimer);
  if (captureBridge) captureBridge.shutdown();
  for (const child of activeChildren) child.kill();
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("navigation:validate", (_event, rawUrl) => {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed)
    return { ok: false, message: "Enter a valid http:// or https:// address." };
  return { ok: true, url: parsed.href };
});

ipcMain.handle("app:get-config", () => ({
  extensionPath: extensionDirectory(),
  startUrl: process.env.MEDIA_SCOUT_START_URL || DEFAULT_START_URL,
  downloadDirectory,
  alwaysOnTop,
  downloadRightsConfirmed,
  pairingCode,
  preferences,
}));

ipcMain.handle("settings:update-preferences", (_event, nextPreferences) => {
  preferences = {
    ...preferences,
    ...Object.fromEntries(
      Object.entries(nextPreferences || {}).filter(([key]) =>
        Object.hasOwn(preferences, key),
      ),
    ),
  };
  saveSettings();
  return { ok: true, preferences };
});

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
    title: "Choose download location",
  });
  if (result.canceled || !result.filePaths[0]) {
    return { cancelled: true, ok: false };
  }
  downloadDirectory = result.filePaths[0];
  saveSettings();
  return { downloadDirectory, ok: true };
});

ipcMain.handle("extension:copy-path", () => {
  const extensionPath = extensionDirectory();
  clipboard.writeText(extensionPath);
  return { ok: true };
});

ipcMain.handle("extension:show-folder", () => {
  const extensionPath = extensionDirectory();
  if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
    return {
      ok: false,
      message: "The packaged browser companion folder is unavailable.",
    };
  }
  shell.openPath(extensionPath);
  return { ok: true, extensionPath };
});

ipcMain.handle("extension:force-refresh", () => {
  if (!captureBridge?.listening) {
    return {
      ok: false,
      message: "The browser companion bridge is unavailable.",
    };
  }
  if (!captureBridge.isPaired()) {
    return {
      ok: false,
      message: "Pair the browser companion before forcing a refresh.",
    };
  }
  captureBridge.enqueueCommand({
    createdAt: Date.now(),
    type: "capture-active",
  });
  appData?.log("info", "force-refresh-requested");
  return { ok: true };
});

ipcMain.handle("page:resolve", async (_event, rawUrl) => {
  return resolveAndCapture(rawUrl);
});

ipcMain.handle("media:copy", (_event, url) => {
  const parsed = parseHttpUrl(url);
  if (!parsed || !detectedUrls.has(parsed.href)) {
    return {
      ok: false,
      message: "This link is not an approved detected media request.",
    };
  }
  clipboard.writeText(parsed.href);
  return { ok: true };
});

ipcMain.handle(
  "media:download",
  async (_event, url, audioUrl = "", title = "", pageUrl = "") => {
    const parsed = parseHttpUrl(url);
    const parsedAudio = audioUrl ? parseHttpUrl(audioUrl) : null;
    if (!parsed || !detectedUrls.has(parsed.href)) {
      return {
        ok: false,
        message: "This link is not an approved detected media request.",
      };
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
        parsedPage.hostname.toLowerCase(),
      )
    ) {
      return enqueueDownload(parsed.href, () =>
        downloadYouTubePage(parsedPage.href, title, parsed.href),
      );
    }
    if (parsedPage && isDouyinVideoUrl(parsedPage.href)) {
      return enqueueDownload(parsed.href, () =>
        downloadDouyinPage(parsedPage.href, title, parsed.href),
      );
    }
    if (parsedAudio) {
      return enqueueDownload(parsed.href, () =>
        mergeMediaDownload(parsed.href, parsedAudio.href, title, pageUrl),
      );
    }
    return enqueueDownload(parsed.href, () => {
      pendingDownloadMetadata.set(parsed.href, { pageUrl, title });
      session.fromPartition(MEDIA_PARTITION).downloadURL(parsed.href);
    });
  },
);

ipcMain.handle("media:cancel", (_event, url) => {
  const parsed = parseHttpUrl(url);
  if (!parsed || !detectedUrls.has(parsed.href)) return { ok: false };
  const queuedIndex = downloadQueue.findIndex((job) => job.url === parsed.href);
  if (queuedIndex >= 0) {
    downloadQueue.splice(queuedIndex, 1);
    send("download:finished", {
      filename: "",
      path: "",
      state: "cancelled",
      url: parsed.href,
    });
    return { ok: true };
  }
  const handle = activeDownloadHandles.get(parsed.href);
  if (!handle) return { ok: false, message: "Download is no longer active." };
  if (typeof handle.cancel === "function") handle.cancel();
  else if (typeof handle.kill === "function") handle.kill();
  return { ok: true };
});

ipcMain.handle("media:toggle-pause", (_event, url) => {
  const parsed = parseHttpUrl(url);
  const handle = parsed ? activeDownloadHandles.get(parsed.href) : null;
  if (!handle || typeof handle.pause !== "function") {
    return {
      ok: false,
      message: "Pause is unavailable while media is being merged or converted.",
    };
  }
  if (handle.isPaused()) {
    handle.resume();
    return { ok: true, paused: false };
  }
  handle.pause();
  return { ok: true, paused: true };
});

ipcMain.handle(
  "media:compatible-preview",
  async (_event, url, audioUrl = "") => {
    const parsed = parseHttpUrl(url);
    const parsedAudio = audioUrl ? parseHttpUrl(audioUrl) : null;
    if (!parsed || !detectedUrls.has(parsed.href)) {
      return {
        ok: false,
        message: "This is not an approved detected media request.",
      };
    }
    if (audioUrl && (!parsedAudio || !detectedUrls.has(parsedAudio.href))) {
      return { ok: false, message: "The detected audio track is unavailable." };
    }
    return transcodePreview(parsed.href, parsedAudio?.href || "");
  },
);

ipcMain.handle("media:open-browser", (_event, url) => {
  const parsed = parseHttpUrl(url);
  if (!parsed || !detectedUrls.has(parsed.href)) {
    return {
      ok: false,
      message: "This link is not an approved detected media request.",
    };
  }
  if (!captureBridge)
    return { ok: false, message: "The browser bridge is unavailable." };
  captureBridge.enqueueCommand({
    createdAt: Date.now(),
    type: "open-media",
    url: parsed.href,
  });
  return { ok: true };
});

ipcMain.handle("media:clear", () => {
  detectedUrls.clear();
  detectedKeys.clear();
  return { ok: true };
});

ipcMain.handle("file:show", (_event, filePath) => {
  if (typeof filePath !== "string") return { ok: false };
  const resolved = path.resolve(filePath);
  if (!completedDownloadPaths.has(resolved) || !fs.existsSync(resolved)) {
    return {
      ok: false,
      message: "This file is not a completed Media Scout download.",
    };
  }
  shell.showItemInFolder(resolved);
  return { ok: true };
});

ipcMain.handle("file:open", async (_event, filePath) => {
  if (typeof filePath !== "string") return { ok: false };
  const resolved = path.resolve(filePath);
  if (!completedDownloadPaths.has(resolved) || !fs.existsSync(resolved)) {
    return { ok: false, message: "This file is unavailable." };
  }
  const message = await shell.openPath(resolved);
  return message ? { ok: false, message } : { ok: true };
});

ipcMain.handle("history:list", () => appData.getHistory());

ipcMain.handle("history:clear", () => {
  appData.clearHistory();
  return { ok: true };
});

ipcMain.handle("capture:batch", async (_event, values) => {
  const urls = [...new Set(Array.isArray(values) ? values : [])].slice(0, 50);
  const results = [];
  for (const url of urls) {
    try {
      results.push({ url, ...(await resolveAndCapture(url, "Batch capture")) });
    } catch (error) {
      appData.log("error", "batch-resolve-failed", {
        message: error.message,
        url,
      });
      results.push({ ok: false, reason: "Resolver failed.", url });
    }
  }
  return { ok: true, results };
});

ipcMain.handle("diagnostics:get", () => {
  let downloadDirectoryWritable = false;
  try {
    fs.accessSync(downloadDirectory, fs.constants.W_OK);
    downloadDirectoryWritable = true;
  } catch {
    downloadDirectoryWritable = false;
  }
  return appData.diagnosticReport({
    appVersion: app.getVersion(),
    bridgeOnline: Boolean(captureBridge?.listening),
    downloadDirectory,
    downloadDirectoryWritable,
    electronVersion: process.versions.electron,
    ffmpegPath: path.basename(ffmpegPath),
    pendingProcesses: activeChildren.size,
    platform: process.platform,
    platformResolvers: "Instagram, YouTube, Bilibili, Douyin configured",
    recoverableFiles: recoverableFiles.length,
    resolverStatus: lastResolverError || "Ready",
    ytDlpPath: path.basename(ytDlpPath),
  });
});

ipcMain.handle("diagnostics:export", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(
      app.getPath("documents"),
      `media-scout-diagnostics-${Date.now()}.json`,
    ),
    filters: [{ extensions: ["json"], name: "JSON" }],
  });
  if (result.canceled || !result.filePath)
    return { ok: false, cancelled: true };
  const report = appData.diagnosticReport({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
  });
  fs.writeFileSync(result.filePath, JSON.stringify(report, null, 2), "utf8");
  return { ok: true, path: result.filePath };
});

ipcMain.handle("privacy:clear-data", async () => {
  appData.clearHistory();
  appData.clearLogs();
  detectedUrls.clear();
  detectedKeys.clear();
  preferences = { ...DEFAULT_PREFERENCES };
  fs.rmSync(settingsPath(), { force: true });
  const previewDirectory = path.join(
    app.getPath("temp"),
    "media-scout-previews",
  );
  if (fs.existsSync(previewDirectory)) {
    fs.rmSync(previewDirectory, { force: true, recursive: true });
  }
  await session.fromPartition(MEDIA_PARTITION).clearStorageData();
  return { ok: true };
});

ipcMain.handle("recovery:list", () =>
  recoverableFiles.map((file) => ({ ...file })),
);

ipcMain.handle("recovery:remove", (_event, filePath) => {
  const index = recoverableFiles.findIndex((file) => file.path === filePath);
  if (index < 0) return { ok: false };
  fs.rmSync(recoverableFiles[index].path, { force: true });
  fs.rmSync(`${recoverableFiles[index].path}.json`, { force: true });
  recoverableFiles.splice(index, 1);
  return { ok: true };
});

ipcMain.handle("recovery:retry", async (_event, filePath) => {
  const index = recoverableFiles.findIndex((file) => file.path === filePath);
  if (index < 0) return { ok: false };
  const file = recoverableFiles[index];
  fs.rmSync(file.path, { force: true });
  fs.rmSync(`${file.path}.json`, { force: true });
  recoverableFiles.splice(index, 1);
  if (file.pageUrl)
    return resolveAndCapture(file.pageUrl, "Recovered download");
  const parsed = parseHttpUrl(file.sourceUrl);
  if (!parsed)
    return { ok: false, message: "No reusable source URL was recorded." };
  addDetectedMedia({
    allowed: true,
    detectedAt: new Date().toISOString(),
    extension: path.extname(parsed.pathname) || ".mp4",
    hostname: parsed.hostname,
    mime: "video/mp4",
    pageHost: parsed.hostname,
    size: 0,
    source: "Recovered download",
    title: file.title || "",
    url: parsed.href,
  });
  return { ok: true };
});

ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) {
    return { ok: false, message: "Updates are available in packaged builds." };
  }
  await updater.checkForUpdates();
  return { ok: true };
});

ipcMain.handle("update:download", async () => {
  await updater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle("update:install", () => {
  updater.quitAndInstall();
});
