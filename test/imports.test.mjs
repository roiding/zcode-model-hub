// Import every module so a wrong relative path surfaces at test time —
// `node --check` only parses, it does not resolve imports (this exact gap
// shipped a broken deploy-skill.mjs once).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const modules = [
  "src/platform.mjs",
  "src/config.mjs",
  "src/deploy-skill.mjs",
  "src/providers/index.mjs",
  "src/archive/surgical-asar.mjs",
  "src/archive/verify.mjs",
  "src/patch/manifest.mjs",
  "src/patch/discover-targets.mjs",
  "src/patch/apply.mjs",
  "src/patch/asar-integrity.mjs",
  "src/repair/ensure.mjs",
  "src/repair/triggers.mjs",
  "bin/zcode-model-hub.mjs",
];

test("every module imports cleanly (relative paths resolve)", async () => {
  for (const rel of modules) {
    // Windows needs a file:// URL for absolute-path dynamic imports
    await import(pathToFileURL(path.join(root, rel)).href);
  }
});

test("deploy-skill asset paths resolve (bin + templates exist)", async () => {
  const { skillAssets } = await import(
    pathToFileURL(path.join(root, "src/deploy-skill.mjs")).href
  );
  const fs = await import("node:fs");
  for (const a of skillAssets()) {
    assert.ok(fs.existsSync(a.cli), `missing: ${a.cli}`);
    assert.ok(fs.existsSync(a.template), `missing: ${a.template}`);
  }
});
