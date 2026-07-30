"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { unpackedBinaryPath } = require("../src/binary-path");

test("maps external binaries out of Electron's virtual ASAR directory", () => {
  assert.equal(
    unpackedBinaryPath(
      "C:\\Program Files\\Media Scout\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe",
    ),
    "C:\\Program Files\\Media Scout\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe",
  );
});

test("maps pnpm binary paths to Electron Builder's flattened unpacked layout", () => {
  assert.equal(
    unpackedBinaryPath(
      "C:\\Program Files\\Media Scout\\resources\\app.asar\\node_modules\\.pnpm\\ffmpeg-static@5.3.0\\node_modules\\ffmpeg-static\\ffmpeg.exe",
    ),
    "C:\\Program Files\\Media Scout\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe",
  );
  assert.equal(
    unpackedBinaryPath(
      "C:\\Program Files\\Media Scout\\resources\\app.asar\\node_modules\\.pnpm\\@distube+yt-dlp@2.0.1\\node_modules\\@distube\\yt-dlp\\bin\\yt-dlp.exe",
    ),
    "C:\\Program Files\\Media Scout\\resources\\app.asar.unpacked\\node_modules\\@distube\\yt-dlp\\bin\\yt-dlp.exe",
  );
});

test("FFmpeg spawn call sites normalize the packaged binary path", () => {
  for (const relativePath of ["src/main.js", "src/capture-bridge.js"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", relativePath),
      "utf8",
    );
    assert.match(
      source,
      /const ffmpegPath = unpackedBinaryPath\(require\("ffmpeg-static"\)\);/,
      `${relativePath} must use the unpacked FFmpeg path`,
    );
  }
});
