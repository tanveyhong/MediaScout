"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { AppData, redact } = require("../src/app-data");

test("persists bounded download history and clears local data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-scout-data-"));
  try {
    const data = new AppData(directory);
    data.addHistory({ id: "one", state: "completed" });
    assert.equal(new AppData(directory).getHistory()[0].id, "one");
    data.addHistory({ fingerprint: "same", id: "two", state: "completed" });
    assert.equal(data.hasFingerprint("same"), true);
    assert.equal(data.hasFingerprint("different"), false);
    data.log("info", "test", { url: "https://example.com/video?token=secret" });
    assert.equal(
      fs.readFileSync(data.logPath, "utf8").includes("secret"),
      false,
    );
    data.clearHistory();
    data.clearLogs();
    assert.deepEqual(data.getHistory(), []);
    assert.equal(fs.existsSync(data.logPath), false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("redacts sensitive query values and URL paths", () => {
  const result = redact("https://example.com/private/video?signature=secret");
  assert.equal(result.includes("secret"), false);
  assert.match(result, /^https:\/\/example\.com\//);
});
