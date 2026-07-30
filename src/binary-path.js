"use strict";

const path = require("node:path");

function unpackedBinaryPath(value) {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return String(value).replace(
    asarSegment,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
}

module.exports = { unpackedBinaryPath };
