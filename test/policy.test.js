"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMedia, parseHttpUrl } = require("../src/policy");

test("accepts direct HTTP media without provider exclusion rules", () => {
  const result = classifyMedia("https://media.example/video.mp4", "video/mp4");
  assert.equal(result.allowed, true);
  assert.equal(result.hostname, "media.example");
});

test("rejects non-HTTP and segmented media", () => {
  assert.equal(parseHttpUrl("file:///tmp/video.mp4"), null);
  assert.equal(
    classifyMedia(
      "https://media.example/stream.m3u8",
      "application/vnd.apple.mpegurl",
    ).allowed,
    false,
  );
});
