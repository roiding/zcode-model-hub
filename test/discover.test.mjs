import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { makeFakeZcode } from "./helpers.mjs";
import { discoverTargets, isAlreadyPatched, detectForeignPatches } from "../src/patch/discover-targets.mjs";
import { packDir, patchEntries, readEntryText } from "../src/archive/surgical-asar.mjs";

test("discoverTargets finds main/preload/renderer by path shape", () => {
  const fx = makeFakeZcode();
  const t = discoverTargets(fx.asar);
  assert.equal(t.main, "out/main/index.js");
  assert.equal(t.preload, "out/preload/index.cjs");
  assert.equal(t.rendererHtml, "out/renderer/index.html");
  assert.equal(t.uiScript, "out/renderer/zcode-model-hub.js");
});

test("discoverTargets fails loudly on an alien layout (no main entry)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-broken-"));
  const asar = path.join(dir, "app.asar");
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, "out", "renderer"), { recursive: true });
  fs.mkdirSync(path.join(src, "out", "preload"), { recursive: true });
  fs.writeFileSync(path.join(src, "out", "renderer", "index.html"), "<body></body>");
  fs.writeFileSync(path.join(src, "out", "preload", "index.cjs"), "x");
  packDir(src, asar);
  assert.throws(() => discoverTargets(asar), /layout mismatch: main entry/);
});

test("isAlreadyPatched / detectForeignPatches", () => {
  const fx = makeFakeZcode();
  const t = discoverTargets(fx.asar);
  assert.equal(isAlreadyPatched(fx.asar, t), false);
  assert.deepEqual(detectForeignPatches(fx.asar, t), []);

  const patched = path.join(fx.resources, "p.asar");
  patchEntries(fx.asar, patched, {
    [t.main]: Buffer.from(readEntryText(fx.asar, t.main) + "\n// __ZCODE_MODEL_HUB_V1__ marker\n", "utf8"),
  });
  const t2 = discoverTargets(patched);
  assert.equal(isAlreadyPatched(patched, t2), true);

  const foreign = path.join(fx.resources, "f.asar");
  patchEntries(fx.asar, foreign, {
    [t.main]: Buffer.from(readEntryText(fx.asar, t.main) + '\nhe.handle("zcode:read-model-config",0)\n', "utf8"),
  });
  const t3 = discoverTargets(foreign);
  assert.deepEqual(detectForeignPatches(foreign, t3), ["zcode-model-puller (HHQ-666)"]);
});
