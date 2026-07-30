"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decodePlaylist, decodeSegment } = require("../src/reanime-resolver");

test("decodes FlixCloud playlists with the WASM-derived key", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const manifest = "#EXTM3U\n#EXT-X-VERSION:3\nvideo.m3u8\n";
  const protectedBytes = Buffer.from(manifest);
  for (let index = 0; index < protectedBytes.length; index += 1) {
    protectedBytes[index] ^= key[index % key.length];
  }

  assert.equal(
    decodePlaylist(protectedBytes.toString("base64"), key),
    manifest,
  );
});

test("removes FlixCloud image disguises and decodes protected segments", () => {
  const transportStream = Buffer.from([0x47, 0x40, 0x11, 0x10, 1, 2, 3, 4]);
  const xorKey = Buffer.from([
    157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197,
  ]);
  const protectedBytes = Buffer.from(transportStream);
  for (let index = 0; index < protectedBytes.length; index += 1) {
    protectedBytes[index] ^= xorKey[index & 15];
  }
  const disguised = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    protectedBytes,
  ]);

  assert.deepEqual(decodeSegment(disguised), transportStream);
});

test("removes an unencrypted WebP disguise without changing media bytes", () => {
  const transportStream = Buffer.from([0x47, 0x40, 0x11, 0x10]);
  const disguised = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    transportStream,
  ]);

  assert.deepEqual(decodeSegment(disguised), transportStream);
});
