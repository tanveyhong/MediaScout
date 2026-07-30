"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "browser-extension", "manifest.json"),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

test("extension access is limited to supported sites and the local bridge", () => {
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal(
    manifest.content_scripts[0].matches.includes("<all_urls>"),
    false,
  );
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:48731/*"));
});

test("packaged builds expose the companion outside the ASAR archive", () => {
  assert.ok(packageJson.build.asarUnpack.includes("browser-extension/**/*"));
});
