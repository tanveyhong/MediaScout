"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ZipArchive } = require("archiver");

async function main() {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "browser-extension");
  const outputDirectory = path.join(root, "dist", "extension-stores");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "manifest.json"), "utf8"),
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `media-scout-companion-${manifest.version}.zip`,
  );
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
