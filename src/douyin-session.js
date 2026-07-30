"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

function isDouyinVideoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      ["douyin.com", "www.douyin.com"].includes(parsed.hostname.toLowerCase()) &&
      /^\/video\/\d+\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function netscapeCookie(cookie) {
  const domain = cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`;
  return [
    domain,
    "TRUE",
    cookie.path || "/",
    cookie.secure ? "TRUE" : "FALSE",
    Math.floor(cookie.expirationDate || Date.now() / 1000 + 3600),
    cookie.name,
    cookie.value
  ].join("\t");
}

async function createAnonymousDouyinSession(pageUrl) {
  if (!isDouyinVideoUrl(pageUrl)) return null;

  const partition = `media-scout-douyin-${crypto.randomUUID()}`;
  const isolatedSession = session.fromPartition(partition);
  const cookieFile = path.join(
    app.getPath("temp"),
    `media-scout-douyin-${crypto.randomUUID()}.txt`
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockExternalProtocol = (event, targetUrl) => {
    try {
      const protocol = new URL(targetUrl).protocol;
      if (!["http:", "https:", "about:", "blob:", "data:"].includes(protocol)) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", blockExternalProtocol);
  window.webContents.on("will-redirect", blockExternalProtocol);
  window.webContents.on("will-frame-navigate", blockExternalProtocol);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  try {
    await window.loadURL(pageUrl);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const cookies = await isolatedSession.cookies.get({ domain: ".douyin.com" });
    if (!cookies.length) throw new Error("Douyin did not establish a public session.");
    fs.writeFileSync(
      cookieFile,
      `# Netscape HTTP Cookie File\n${cookies.map(netscapeCookie).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }

  return {
    cookieFile,
    dispose() {
      fs.rmSync(cookieFile, { force: true });
      isolatedSession.clearStorageData().catch(() => {});
    }
  };
}

module.exports = { createAnonymousDouyinSession, isDouyinVideoUrl };
