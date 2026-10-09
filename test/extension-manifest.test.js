"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "browser-extension", "manifest.json"),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

test("extension can observe media on arbitrary web pages and use the local bridge", () => {
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.ok(
    manifest.content_scripts.some((script) =>
      script.matches.includes("<all_urls>"),
    ),
  );
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:48731/*"));
  assert.ok(manifest.host_permissions.includes("https://*.flixcloud.cc/*"));
  assert.ok(
    manifest.content_scripts.some(
      (script) =>
        script.world === "MAIN" &&
        script.run_at === "document_start" &&
        script.all_frames &&
        script.js.includes("player-hook.js"),
    ),
  );
});

test("packaged builds expose the companion outside the ASAR archive", () => {
  assert.ok(packageJson.build.asarUnpack.includes("browser-extension/**/*"));
});

test("desktop pairing is persisted with Electron safe storage", () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  assert.match(mainSource, /safeStorage\.encryptString\(pairingCode\)/);
  assert.match(mainSource, /safeStorage\.decryptString\(/);
  assert.doesNotMatch(mainSource, /pairingCode:\s*pairingCode/);
});

test("the desktop window and tray use the runtime Media Scout icon", () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  assert.match(mainSource, /app\.setName\(APP_NAME\)/);
  assert.match(mainSource, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(
    mainSource,
    /process\.platform === "win32" \? "media-scout\.ico" : "media-scout-logo\.png"/,
  );
  assert.match(mainSource, /icon:\s*appIcon/);
  assert.match(mainSource, /mainWindow\.setIcon\(appIcon\)/);
  assert.match(
    mainSource,
    /new Tray\(icon\.resize\(\{\s*height:\s*32,\s*width:\s*32\s*\}\)\)/,
  );
});

test("service worker only filters on valid webRequest resource types", () => {
  // Chrome rejects unknown types at registration, which stops the worker
  // before its message listeners exist.
  const valid = new Set([
    "csp_report",
    "font",
    "image",
    "main_frame",
    "media",
    "object",
    "other",
    "ping",
    "script",
    "stylesheet",
    "sub_frame",
    "webbundle",
    "websocket",
    "xmlhttprequest",
  ]);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "browser-extension", "service-worker.js"),
    "utf8",
  );
  const typeLists = [...source.matchAll(/types:\s*\[([^\]]*)\]/g)];
  assert.ok(typeLists.length > 0);
  for (const [, list] of typeLists) {
    for (const [, type] of list.matchAll(/"([^"]+)"/g)) {
      assert.ok(valid.has(type), `invalid webRequest type: ${type}`);
    }
  }
});
