"use strict";

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
