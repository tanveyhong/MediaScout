"use strict";

const { autoUpdater } = require("electron-updater");

function configureUpdates(send, log) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const forward = (state, details = {}) => {
    log?.("info", "update-state", { state });
    send("update:status", { state, ...details });
  };
  autoUpdater.on("checking-for-update", () => forward("checking"));
  autoUpdater.on("update-available", (info) =>
    forward("available", { version: info.version }),
  );
  autoUpdater.on("update-not-available", (info) =>
    forward("current", { version: info.version }),
  );
  autoUpdater.on("download-progress", (progress) =>
    forward("downloading", {
      percent: Math.round(progress.percent || 0),
      transferred: progress.transferred,
      total: progress.total,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    forward("ready", { version: info.version }),
  );
  autoUpdater.on("error", (error) => {
    log?.("error", "update-error", { message: error.message });
    forward("error", { message: "Update check failed." });
  });
  return autoUpdater;
}

module.exports = { configureUpdates };
