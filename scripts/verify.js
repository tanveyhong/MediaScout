"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const nodeExecutable = process.execPath;
const folders = ["src", "scripts", "test", "browser-extension"];
const javascriptFiles = folders.flatMap((folder) =>
  fs
    .readdirSync(path.join(projectRoot, folder), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(projectRoot, folder, entry.name))
);

for (const file of javascriptFiles) {
  const check = spawnSync(nodeExecutable, ["--check", file], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status || 1);
}

const tests = spawnSync(nodeExecutable, ["--test"], {
  cwd: projectRoot,
  stdio: "inherit"
});
if (tests.status !== 0) process.exit(tests.status || 1);

process.stdout.write(
  "\nVerification passed. Run `pnpm test:local` for the interactive local test.\n"
);
