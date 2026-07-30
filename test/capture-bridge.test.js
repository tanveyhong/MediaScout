"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { startCaptureBridge } = require("../src/capture-bridge");

test("rejects page resolution from ordinary web origins", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ pageUrl: "https://instagram.com/reel/Test123/" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("removes the legacy response-capture endpoint", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "chrome-extension://abcdefghijklmnop",
      },
      body: JSON.stringify({ url: "https://media.example/file.mp4" }),
    });
    assert.equal(response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("delivers queued browser commands only to extension origins", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  server.enqueueCommand({
    type: "open-media",
    url: "https://media.example/file.mp4",
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: "chrome-extension://abcdefghijklmnop" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).commands.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("delivers a force-refresh command to the paired companion", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  server.enqueueCommand({ type: "capture-active" });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: "chrome-extension://trustedcompanion" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).commands, [
      { type: "capture-active" },
    ]);
  } finally {
    server.shutdown();
  }
});

test("pairs with one extension origin for the lifetime of the bridge", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const paired = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: "chrome-extension://trustedcompanion" },
    });
    assert.equal(paired.status, 200);

    const other = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: "chrome-extension://anotherextension" },
    });
    assert.equal(other.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("requires the desktop pairing code when configured", async () => {
  const server = startCaptureBridge(
    () => {},
    0,
    () => ({}),
    { pairingCode: "123456" },
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const origin = "chrome-extension://trustedcompanion";
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: origin },
    });
    assert.equal(rejected.status, 403);

    const paired = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Media-Scout-Pairing": "123456",
      },
    });
    assert.equal(paired.status, 200);

    const commands = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: origin },
    });
    assert.equal(commands.status, 200);
  } finally {
    server.shutdown();
  }
});

test("rejects oversized capture payloads without resolving them", async () => {
  let captures = 0;
  const server = startCaptureBridge(() => {
    captures += 1;
  }, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "chrome-extension://trustedcompanion",
      },
      body: JSON.stringify({
        pageUrl: `https://example.com/${"x".repeat(40_000)}`,
      }),
    });
    assert.equal(response.status, 413);
    assert.equal(captures, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("shutdown destroys active bridge connections", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const closed = new Promise((resolve) => socket.once("close", resolve));
  server.shutdown();
  await closed;

  assert.equal(socket.destroyed, true);
  assert.equal(server.listening, false);
});
