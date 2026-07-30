"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  genericProviderFor,
  normalizeDomainList,
} = require("../src/provider-registry");

test("recognizes direct media and trusted public-content providers", () => {
  assert.equal(
    genericProviderFor("https://cdn.example.org/video.mp4").id,
    "direct-media",
  );
  assert.equal(
    genericProviderFor("https://archive.org/details/sample").id,
    "public-content",
  );
  assert.equal(
    genericProviderFor("https://commons.wikimedia.org/wiki/File:Sample.webm")
      .id,
    "public-content",
  );
});

test("recognizes only supported nnyy.in movie pages", () => {
  assert.deepEqual(
    genericProviderFor(
      "https://www.nnyy.in/dianying/20168832.html?source=test",
    ),
    {
      id: "nnyy",
      url: "https://nnyy.in/dianying/20168832.html",
    },
  );
  assert.equal(
    genericProviderFor("https://nnyy.in/dianying/not-a-movie"),
    null,
  );
  assert.equal(
    genericProviderFor("https://example.com/dianying/20168832.html"),
    null,
  );
});

test("limits generic pages to normalized user-authorized domains", () => {
  const domains = normalizeDomainList(
    "https://media.example.org/path, assets.example.net",
  );
  assert.deepEqual(domains, ["media.example.org", "assets.example.net"]);
  assert.equal(
    genericProviderFor("https://video.media.example.org/watch/1", domains).id,
    "authorized-domain",
  );
  assert.equal(genericProviderFor("https://unapproved.example/watch/1"), null);
});
