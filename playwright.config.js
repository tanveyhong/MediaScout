"use strict";

module.exports = {
  testDir: "./e2e",
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
  workers: 1,
};
