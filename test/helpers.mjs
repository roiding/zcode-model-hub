// Shared fixture builder: a synthetic "ZCode build" asar.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { packDir } from "../src/archive/surgical-asar.mjs";

export function makeFakeZcode({ mainExtra = "", withUnpacked = false } = {}) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-src-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-out-"));
  const resources = path.join(out, "resources");
  fs.mkdirSync(resources, { recursive: true });

  const dirs = ["out/main", "out/preload", "out/renderer/assets", "vendor/extra"];
  for (const d of dirs) fs.mkdirSync(path.join(src, d), { recursive: true });

  fs.writeFileSync(
    path.join(src, "out/main/index.js"),
    `"use strict";\nconst { app } = require("electron");\napp.whenReady().then(() => {});\n${mainExtra}\n`,
  );
  fs.writeFileSync(
    path.join(src, "out/preload/index.cjs"),
    `const { contextBridge } = require("electron");\ncontextBridge.exposeInMainWorld("zcode", { ok: 1 });\n`,
  );
  fs.writeFileSync(
    path.join(src, "out/renderer/index.html"),
    `<!doctype html><html><head><title>z</title></head><body><div id="root"></div>\n  <script src="./assets/index.js"></script>\n</body></html>\n`,
  );
  fs.writeFileSync(path.join(src, "out/renderer/assets/index.js"), "// big bundle\n" + "x".repeat(4096));
  fs.writeFileSync(path.join(src, "vendor/extra/lib.js"), "module.exports = 42;\n");
  if (withUnpacked) {
    fs.writeFileSync(path.join(src, "vendor/native.node"), "BIN".repeat(100));
  }

  const asar = path.join(resources, "app.asar");
  packDir(src, asar, { unpackedSet: withUnpacked ? ["vendor/native.node"] : [] });
  return { src, resources, asar, outDir: out };
}

export function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zmh-state-"));
}
