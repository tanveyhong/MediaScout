"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMedia, parseHttpUrl } = require("../src/policy");

test("accepts direct HTTP media without provider exclusion rules", () => {
  const result = classifyMedia("https://media.example/video.mp4", "video/mp4");
  assert.equal(result.allowed, true);
  assert.equal(result.hostname, "media.example");
});

test("accepts sb-cd direct video download URLs", () => {
  const result = classifyMedia(
    "https://vdownload-21.sb-cd.com/1/7/1762161-320p.mp4?secure=aXUY-uTuaLQRykVkjjkL5Q,1786199321&m=21&d=2&_tid=1762161",
  );
  assert.equal(result.allowed, true);
  assert.equal(result.extension, ".mp4");
  assert.equal(result.hostname, "vdownload-21.sb-cd.com");
});

test("rejects non-HTTP and individual transport stream segments", () => {
  assert.equal(parseHttpUrl("file:///tmp/video.mp4"), null);
  assert.equal(
    classifyMedia("https://media.example/segment.ts", "video/mp2t").allowed,
    false,
  );
});

test("accepts HLS playlists by extension or MIME type", () => {
  const byExtension = classifyMedia("https://media.example/stream.m3u8");
  assert.equal(byExtension.allowed, true);
  assert.equal(byExtension.extension, ".m3u8");
  assert.equal(byExtension.isHls, true);

  const byMime = classifyMedia(
    "https://media.example/playback?id=123",
    "application/vnd.apple.mpegurl; charset=utf-8",
  );
  assert.equal(byMime.allowed, true);
  assert.equal(byMime.extension, ".m3u8");
  assert.equal(byMime.isHls, true);
});
