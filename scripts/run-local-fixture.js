"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createFixtureServer } = require("./local-fixture");

const projectRoot = path.resolve(__dirname, "..");
const electronExecutable = require("electron");
const server = createFixtureServer();

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const startUrl = `http://127.0.0.1:${address.port}/`;
  process.stdout.write(`Media Scout local test: ${startUrl}\n`);

  const child = spawn(electronExecutable, [projectRoot], {
    cwd: projectRoot,
    env: { ...process.env, MEDIA_SCOUT_START_URL: startUrl },
    stdio: "inherit",
  });

  child.once("exit", (code) => {
    server.close(() => process.exit(code || 0));
  });
});

process.once("SIGINT", () => server.close(() => process.exit(0)));
