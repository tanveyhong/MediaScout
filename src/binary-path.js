"use strict";

const path = require("node:path");

function unpackedBinaryPath(value) {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const unpacked = String(value).replace(
    asarSegment,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
  const pnpmSegment = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
  const pnpmIndex = unpacked.indexOf(pnpmSegment);
  if (pnpmIndex < 0) return unpacked;
  const nestedModules = `${path.sep}node_modules${path.sep}`;
  const packageIndex = unpacked.indexOf(
    nestedModules,
    pnpmIndex + pnpmSegment.length,
  );
  if (packageIndex < 0) return unpacked;
  return (
    unpacked.slice(0, pnpmIndex) +
    nestedModules +
    unpacked.slice(packageIndex + nestedModules.length)
  );
}

module.exports = { unpackedBinaryPath };
