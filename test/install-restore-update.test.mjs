// End-to-end: install -> verify -> restore -> simulate a ZCode update ->
// ensure() auto-repatches. This is the core promise of the tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeFakeZcode, tempStateDir } from "./helpers.mjs";
import { discoverTargets, isAlreadyPatched, detectForeignPatches } from "../src/patch/discover-targets.mjs";
import { packDir, readEntryText } from "../src/archive/surgical-asar.mjs";
import { sha256File } from "../src/archive/verify.mjs";
import { loadManifest, listBackups, readPending, pruneBackups, saveManifest, backupPathFor, PATCH_VERSION } from "../src/patch/manifest.mjs";
import { install, restore, inspectInjection } from "../src/patch/apply.mjs";
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

  // upgrade path: recorded entry hash no longer matches the current snippets
  // (simulates a UI-script change) -> install rebuilds from the cold backup
  const tUp = discoverTargets(fx.asar);
  m.entryHashes[tUp.uiScript] = "0".repeat(64);
  saveManifest(m, state);
  const up = await install({ resourcesOverride: fx.resources, _isRunning: NOT_RUNNING });
  assert.equal(up.updated, true);
  const m2 = loadManifest(state);
  assert.notEqual(m2.entryHashes[tUp.uiScript], "0".repeat(64));
  assert.ok(readEntryText(fx.asar, tUp.uiScript).includes("__ZCODE_MODEL_HUB_V1_UI__"));
  assert.ok(readEntryText(fx.asar, tUp.main).includes("__ZCODE_MODEL_HUB_V1__"));
  assert.equal(readEntryText(fx.asar, "vendor/extra/lib.js"), "module.exports = 42;\n"); // data region intact

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
  // On a machine where the user legitimately installed the tool, the real
  // asar IS expected to contain the sentinel — only assert "untouched" when
  // there is no real install record. NOTE: check the REAL state dir, not
  // manifestPath(), because this test redirected it via env above.
  const live = "/Applications/ZCode.app/Contents/Resources/app.asar";
  const realManifest = path.join(
    os.homedir(), ".zcode", "model-hub", "manifest.json",
  );
  if (fs.existsSync(live) && !fs.existsSync(realManifest)) {
    assert.equal(fs.readFileSync(live).includes("__ZCODE_MODEL_HUB_V1__"), false);
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

test("restore refuses a corrupted cold backup without changing the live archive", async () => {
  process.env.ZCODE_MODEL_HUB_STATE_DIR = tempStateDir();
  const fixture = makeFakeZcode();
  await install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING });
  const manifest = loadManifest();
  const liveHash = sha256File(fixture.asar);
  fs.writeFileSync(backupPathFor(manifest.originalHash), "BROKEN BACKUP");
  await assert.rejects(() => restore({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING }), /备份哈希不匹配/);
  assert.equal(sha256File(fixture.asar), liveHash);
});

test("snippet upgrades refresh patchVersion instead of retaining the old manifest version", async () => {
  process.env.ZCODE_MODEL_HUB_STATE_DIR = tempStateDir();
  const fixture = makeFakeZcode();
  await install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING });
  const manifest = loadManifest();
  manifest.patchVersion = "old-version";
  manifest.entryHashes[manifest.targets.uiScript] = "changed";
  saveManifest(manifest);
  const result = await install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING });
  assert.equal(result.updated, true);
  assert.equal(loadManifest().patchVersion, PATCH_VERSION);
});

function macIntegrityFixture(states) {
  process.env.ZCODE_MODEL_HUB_STATE_DIR = tempStateDir();
  const fixture = makeFakeZcode();
  const contents = path.join(fixture.outDir, "ZCode.app", "Contents");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const archive = path.join(resources, "app.asar");
  fs.copyFileSync(fixture.asar, archive);
  fs.writeFileSync(path.join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>fixture</string></dict></dict></dict></plist>');
  const binaryPath = path.join(contents, "Frameworks", "Electron Framework.framework", "Electron Framework");
  if (states !== undefined) {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, Buffer.concat([Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([1, states.length]), Buffer.from(states)]));
  }
  return { resources, archive, binaryPath, contents };
}

test("macOS enabled ASAR validation fuse blocks installation", { skip: process.platform !== "darwin" }, async () => {
  const fixture = macIntegrityFixture("101110011");
  const originalHash = sha256File(fixture.archive);
  await assert.rejects(() => install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING }), /EnableEmbeddedAsarIntegrityValidation fuse 已启用/);
  assert.equal(sha256File(fixture.archive), originalHash);
});

test("macOS plist metadata with a disabled fuse permits install and snippet upgrades", { skip: process.platform !== "darwin" }, async () => {
  const fixture = macIntegrityFixture("101100011");
  const binaryBefore = fs.readFileSync(fixture.binaryPath);
  const plistPath = path.join(fixture.contents, "Info.plist");
  const plistBefore = fs.readFileSync(plistPath);
  const result = await install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING });
  assert.equal(result.ok, true);
  const manifest = loadManifest();
  manifest.entryHashes[manifest.targets.uiScript] = "changed";
  saveManifest(manifest);
  const upgrade = await install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING });
  assert.equal(upgrade.updated, true);
  assert.equal(inspectInjection({ resourcesOverride: fixture.resources }).asarIntegrity.status, "disabled");
  assert.deepEqual(fs.readFileSync(fixture.binaryPath), binaryBefore);
  assert.deepEqual(fs.readFileSync(plistPath), plistBefore);
});

test("macOS unknown fuse state is reported honestly and leaves the archive untouched", { skip: process.platform !== "darwin" }, async () => {
  const fixture = macIntegrityFixture();
  const originalHash = sha256File(fixture.archive);
  await assert.rejects(() => install({ resourcesOverride: fixture.resources, _isRunning: NOT_RUNNING }), /无法确认.*完整性校验开关/);
  assert.equal(sha256File(fixture.archive), originalHash);
});
