"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

if (process.env.MEDIA_SCOUT_RELEASE_CONFIRMED !== "yes") {
  process.stderr.write(
    [
      "Release blocked: no explicit confirmation was provided.",
      "First run `pnpm verify` and `pnpm test:local`.",
      "After manually confirming detection, preview, copy, and save, run:",
      "$env:MEDIA_SCOUT_RELEASE_CONFIRMED='yes'; pnpm release",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const verification = spawnSync(process.execPath, ["scripts/verify.js"], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (verification.status !== 0) process.exit(verification.status || 1);

const builder = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);
const release = spawnSync(builder, ["--win", "nsis", "--publish", "never"], {
  cwd: projectRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});
process.exit(release.status || 0);
