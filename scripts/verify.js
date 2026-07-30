"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const nodeExecutable = process.execPath;
const folders = ["src", "scripts", "test", "browser-extension"];

function findJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const javascriptFiles = folders.flatMap((folder) =>
  findJavaScriptFiles(path.join(projectRoot, folder)),
);

for (const file of javascriptFiles) {
  const check = spawnSync(nodeExecutable, ["--check", file], {
    stdio: "inherit",
  });
  if (check.status !== 0) process.exit(check.status || 1);
}

const tests = spawnSync(nodeExecutable, ["--test"], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (tests.status !== 0) process.exit(tests.status || 1);

const lintExecutable = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "eslint.cmd" : "eslint",
);
const lint = spawnSync(lintExecutable, folders, {
  cwd: projectRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (lint.status !== 0) process.exit(lint.status || 1);

process.stdout.write(
  "\nVerification passed. Run `pnpm test:local` for the interactive local test.\n",
);
