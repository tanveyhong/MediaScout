"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createFixtureServer,
  createWaveBuffer,
} = require("../scripts/local-fixture");

test("creates a valid PCM WAV fixture", () => {
  const wave = createWaveBuffer(1);
  assert.equal(wave.subarray(0, 4).toString(), "RIFF");
  assert.equal(wave.subarray(8, 12).toString(), "WAVE");
  assert.equal(wave.subarray(36, 40).toString(), "data");
  assert.ok(wave.length > 44);
});

test("serves the local test page and direct audio response", async () => {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const audio = await fetch(`http://127.0.0.1:${port}/test-tone.wav`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Detection test bench/);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.ok((await audio.arrayBuffer()).byteLength > 44);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
