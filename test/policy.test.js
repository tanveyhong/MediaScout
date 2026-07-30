"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMedia, parseHttpUrl } = require("../src/policy");

test("accepts direct HTTP media without provider exclusion rules", () => {
  const result = classifyMedia("https://media.example/video.mp4", "video/mp4");
  assert.equal(result.allowed, true);
  assert.equal(result.hostname, "media.example");
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
