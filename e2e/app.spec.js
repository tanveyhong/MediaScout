"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect, _electron: electron } = require("@playwright/test");

test("launches and preserves companion pairing across a restart", async () => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-scout-e2e-user-"),
  );
  let firstApp;
  let secondApp;
  try {
    firstApp = await electron.launch({
      args: [".", `--user-data-dir=${userData}`],
    });
    const firstWindow = await firstApp.firstWindow();
    await expect(firstWindow).toHaveTitle("Media Scout");
    const firstCode = await firstWindow.evaluate(
      () => window.mediaScout.getConfig().then((config) => config.pairingCode),
    );
    expect(firstCode).toMatch(/^\d{6}$/);
    await firstApp.close();
    firstApp = null;

    secondApp = await electron.launch({
      args: [".", `--user-data-dir=${userData}`],
    });
    const secondWindow = await secondApp.firstWindow();
    const secondCode = await secondWindow.evaluate(
      () => window.mediaScout.getConfig().then((config) => config.pairingCode),
    );
    expect(secondCode).toBe(firstCode);
  } finally {
    await firstApp?.close();
    await secondApp?.close();
    fs.rmSync(userData, { force: true, recursive: true });
  }
});
