// End-to-end: install -> verify -> restore -> simulate a ZCode update ->
// ensure() auto-repatches. This is the core promise of the tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeFakeZcode, tempStateDir } from "./helpers.mjs";
import { discoverTargets, isAlreadyPatched, detectForeignPatches } from "../src/patch/discover-targets.mjs";
import { packDir, readEntryText } from "../src/archive/surgical-asar.mjs";
import { sha256File } from "../src/archive/verify.mjs";
import { loadManifest, listBackups, readPending, pruneBackups } from "../src/patch/manifest.mjs";
import { install, restore } from "../src/patch/apply.mjs";
import { runEnsure } from "../src/repair/ensure.mjs";

const NOT_RUNNING = () => false;
const RUNNING = () => true;

test("install -> sentinel present -> second install refused -> restore", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode();
  const originalHash = sha256File(fx.asar);

  const res = await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
  assert.equal(res.ok, true);
  const t = discoverTargets(fx.asar);
  assert.equal(isAlreadyPatched(fx.asar, t), true);
  assert.ok(readEntryText(fx.asar, t.main).includes("__ZCODE_MODEL_HUB_V1__"));
  assert.ok(readEntryText(fx.asar, t.preload).includes('exposeInMainWorld("zcodeModelHub"'));
  const html = readEntryText(fx.asar, t.rendererHtml);
  assert.ok(html.includes("zcode-model-hub.js"));
  assert.ok(html.includes("</body>"));
  assert.ok(readEntryText(fx.asar, t.uiScript).includes("__ZCODE_MODEL_HUB_V1_UI__"));
  // untouched entry preserved byte-for-byte
  assert.equal(readEntryText(fx.asar, "vendor/extra/lib.js"), "module.exports = 42;\n");
  // backup + manifest
  assert.equal(sha256File(path.join(state, "backups", originalHash, "app.asar")), originalHash);
  const m = loadManifest(state);
  assert.equal(m.originalHash, originalHash);
  assert.equal(m.patchedHash, sha256File(fx.asar));

  // double install is idempotent: completes the remaining layers, no repatch
  const again = await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(sha256File(fx.asar), m.patchedHash); // untouched by the second run

  // foreign patch detection on a clean build carrying an upstream marker
  const fx2 = makeFakeZcode();
  fs.appendFileSync(path.join(fx2.src, "out/main/index.js"), '\nhe.handle("zcode:fetch-models-from-url",0);\n');
  const foreignAsar = path.join(fx2.resources, "foreign.asar");
  packDir(fx2.src, foreignAsar);
  assert.equal(detectForeignPatches(foreignAsar, discoverTargets(foreignAsar)).length > 0, true);

  // restore returns to the exact official bytes
  const r = await restore({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
  assert.equal(r.ok, true);
  assert.equal(sha256File(fx.asar), originalHash);
  assert.equal(isAlreadyPatched(fx.asar, t), false);
  assert.ok(listBackups(state).length >= 1);
});

test("running app refuses install in auto mode, defers instead of writing", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode();
  await assert.rejects(
    () =>
      install({
        resourcesOverride: fx.resources,
        auto: true,
        _isRunning: RUNNING,
      }),
    /deferred/,
  );
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), false);
});

test("REGRESSION: auto install without explicit resources dir is refused", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  await assert.rejects(
    () => install({ auto: true, _isRunning: NOT_RUNNING }),
    /auto repair requires an explicit resources dir/,
  );
  // and the real installation (if present on this machine) is untouched
  const { existsSync, readFileSync } = fs;
  const live = "/Applications/ZCode.app/Contents/Resources/app.asar";
  if (existsSync(live)) {
    assert.equal(readFileSync(live).includes("__ZCODE_MODEL_HUB_V1__"), false);
  }
});

test("THE update-resilience loop: ZCode update wipes patch, ensure() repatches", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode({ mainExtra: "// v1" });

  // 1. install on "v1"
  await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), true);
  const patchedHashV1 = sha256File(fx.asar);

  // ensure() fast path: nothing to do (stat matches manifest)
  let r = await runEnsure({ asarPath: fx.asar, isRunning: NOT_RUNNING, waitStableMs: 0 });
  assert.equal(r.action, "ok");

  // 2. ZCode update: the whole archive is replaced by a new official build
  fs.writeFileSync(path.join(fx.src, "out/main/index.js"), '"use strict";// v2 official build\n');
  fs.writeFileSync(
    path.join(fx.src, "out/renderer/index.html"),
    "<!doctype html><html><body><div id=app></div>\n</body></html>",
  );
  const newAsar = path.join(fx.resources, "app.asar.updated");
  packDir(fx.src, newAsar);
  fs.renameSync(newAsar, fx.asar); // updater-style replace
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), false);

  // 3. ensure() notices and auto-repatches (ZCode not running)
  r = await runEnsure({ asarPath: fx.asar, isRunning: NOT_RUNNING, waitStableMs: 0 });
  assert.equal(r.action, "repatched");
  const t2 = discoverTargets(fx.asar);
  assert.equal(isAlreadyPatched(fx.asar, t2), true);
  assert.ok(readEntryText(fx.asar, t2.main).includes("// v2 official build")); // new official code preserved
  assert.ok(readEntryText(fx.asar, t2.main).includes("__ZCODE_MODEL_HUB_V1__")); // plus our block
  const m = loadManifest(state);
  assert.equal(m.patchedHash, sha256File(fx.asar));
  assert.notEqual(m.patchedHash, patchedHashV1);

  // 4. ensure() again -> fast path ok
  r = await runEnsure({ asarPath: fx.asar, isRunning: NOT_RUNNING, waitStableMs: 0 });
  assert.equal(r.action, "ok");
});

test("update while ZCode is running -> deferred, pending recorded, retried later", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode();

  await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });

  // update happens while ZCode is running
  fs.writeFileSync(path.join(fx.src, "out/main/index.js"), '"use strict";// v3\n');
  const newAsar = path.join(fx.resources, "app.asar.updated");
  packDir(fx.src, newAsar);
  fs.renameSync(newAsar, fx.asar);

  const r = await runEnsure({ asarPath: fx.asar, isRunning: RUNNING, waitStableMs: 0 });
  assert.equal(r.action, "deferred-running");
  assert.equal(readPending(state).reason, "zcode-running");
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), false); // untouched

  // later: ZCode closed -> ensure completes the repair and clears pending
  const r2 = await runEnsure({ asarPath: fx.asar, isRunning: NOT_RUNNING, waitStableMs: 0 });
  assert.equal(r2.action, "repatched");
  assert.equal(readPending(state), null);
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), true);
});

test("check-only ensure diagnoses without writing", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode();
  const r = await runEnsure({ asarPath: fx.asar, isRunning: NOT_RUNNING, waitStableMs: 0, allowPatch: false });
  assert.equal(r.action, "needs-patch");
  assert.equal(isAlreadyPatched(fx.asar, discoverTargets(fx.asar)), false);
});

test("backup pruning keeps only the last 2 ZCode versions", async () => {
  const state = tempStateDir();
  process.env.ZCODE_MODEL_HUB_STATE_DIR = state;
  const fx = makeFakeZcode({ mainExtra: "// official v-a" });

  const installVersion = async (tag) => {
    const build = makeFakeZcode({ mainExtra: `// official ${tag}` });
    const nextAsar = path.join(build.resources, "next.asar");
    packDir(build.src, nextAsar);
    const officialHash = sha256File(nextAsar);
    fs.copyFileSync(nextAsar, fx.asar); // updater-style replace at the same path
    await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
    return officialHash;
  };

  await installVersion("v-a");
  await installVersion("v-b");
  assert.equal(listBackups(state).length, 2);
  const officialHashC = await installVersion("v-c"); // install auto-prunes to the newest 2
  const backups = listBackups(state);
  assert.equal(backups.length, 2);
  // the oldest (v-a) backup was pruned; newest kept
  const m = loadManifest(state);
  assert.equal(m.originalHash, officialHashC); // manifest matches the current official build
  pruneBackups(2, state); // idempotent
  assert.equal(listBackups(state).length, 2);
});
