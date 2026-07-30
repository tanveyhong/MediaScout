"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startCaptureBridge } = require("../src/capture-bridge");

test("rejects page resolution from ordinary web origins", async () => {
  const server = startCaptureBridge(() => {}, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ pageUrl: "https://instagram.com/reel/Test123/" })
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
        Origin: "chrome-extension://abcdefghijklmnop"
      },
      body: JSON.stringify({ url: "https://media.example/file.mp4" })
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
  server.enqueueCommand({ type: "open-media", url: "https://media.example/file.mp4" });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Origin: "chrome-extension://abcdefghijklmnop" }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).commands.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
