"use strict";

const fs = require("node:fs");
const path = require("node:path");

function redact(value) {
  return String(value || "")
    .replace(
      /([?&](?:token|sig|signature|auth|key|expires))=[^&\s]+/gi,
      "$1=REDACTED",
    )
    .replace(/(https?:\/\/[^/\s]+)\/[^\s]+/gi, "$1/…");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

class AppData {
  constructor(directory) {
    this.directory = directory;
    this.historyPath = path.join(directory, "download-history.json");
    this.logPath = path.join(directory, "media-scout.log");
    this.history = readJson(this.historyPath, []);
    if (!Array.isArray(this.history)) this.history = [];
  }

  addHistory(entry) {
    this.history.unshift(entry);
    this.history = this.history.slice(0, 500);
    writeJson(this.historyPath, this.history);
  }

  getHistory() {
    return this.history.map((entry) => ({ ...entry }));
  }

  clearHistory() {
    this.history = [];
    writeJson(this.historyPath, this.history);
  }

  log(level, event, details = {}) {
    fs.mkdirSync(this.directory, { recursive: true });
    if (
      fs.existsSync(this.logPath) &&
      fs.statSync(this.logPath).size > 2_000_000
    ) {
      const previous = `${this.logPath}.1`;
      fs.rmSync(previous, { force: true });
      fs.renameSync(this.logPath, previous);
    }
    const safeDetails = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, redact(value)]),
    );
    fs.appendFileSync(
      this.logPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        details: safeDetails,
        event,
        level,
      })}\n`,
      "utf8",
    );
  }

  clearLogs() {
    fs.rmSync(this.logPath, { force: true });
    fs.rmSync(`${this.logPath}.1`, { force: true });
  }

  diagnosticReport(extra = {}) {
    return {
      generatedAt: new Date().toISOString(),
      historyEntries: this.history.length,
      logPath: this.logPath,
      ...extra,
    };
  }
}

module.exports = { AppData, readJson, redact, writeJson };
