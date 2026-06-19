"use strict";
// Node.js wrapper around steg-core: adds PNG file I/O.
const { PNG } = require("pngjs");
const fs      = require("fs");
const StegCore = require("./steg-core");

function readPng(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  return new StegCore.Img(png.width, png.height, new Uint8Array(png.data));
}

function writePng(filePath, img) {
  const png  = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

module.exports = { ...StegCore, readPng, writePng };
