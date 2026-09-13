// Syntax-check every JS payload + module with the current Node binary.
// The injected snippets must parse as a Script (main) / CJS (preload) /
// classic script in the renderer, so plain `node --check` is the right gate.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [
  "bin/zcode-model-hub.mjs",
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
  "src/patch/snippets/main-handlers.js",
  "src/patch/snippets/preload-bridge.cjs",
  "src/patch/snippets/ui/zcode-model-hub.js",
];

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}\n${r.stderr}`);
  } else {
    console.log(`ok   ${f}`);
  }
}
process.exit(failed ? 1 : 0);
