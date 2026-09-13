// Import every module so a wrong relative path surfaces at test time —
// `node --check` only parses, it does not resolve imports (this exact gap
// shipped a broken deploy-skill.mjs once).
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "src/repair/ensure.mjs",
  "src/repair/triggers.mjs",
  "bin/zcode-model-hub.mjs",
];

test("every module imports cleanly (relative paths resolve)", async () => {
  for (const rel of modules) {
    await import(path.join(root, rel)); // throws on unresolved imports
  }
});
