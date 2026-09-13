import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeFakeZcode } from "./helpers.mjs";
import { listFiles, readEntry, readEntryText, patchEntries } from "../src/archive/surgical-asar.mjs";
import { sha256Buf, verifyPatchedArchive, peekHeader } from "../src/archive/verify.mjs";

test("packDir + listFiles + readEntry round-trip", () => {
  const fx = makeFakeZcode({ withUnpacked: true });
  const { files } = listFiles(fx.asar);
  const rels = files.map((f) => f.rel).sort();
  assert.ok(rels.includes("out/main/index.js"));
  assert.ok(rels.includes("out/preload/index.cjs"));
  assert.ok(rels.includes("out/renderer/index.html"));
  assert.ok(rels.includes("vendor/native.node"));
  const unp = files.find((f) => f.rel === "vendor/native.node");
  assert.equal(unp.unpacked, true);
  assert.equal(readEntryText(fx.asar, "vendor/extra/lib.js"), "module.exports = 42;\n");
  assert.equal(readEntry(fx.asar, "vendor/native.node"), null); // unpacked entries are not in the payload
  assert.equal(readEntryText(fx.asar, "no/such/entry"), null);
});

test("patchEntries replaces one entry and creates a new one; original region untouched", () => {
  const fx = makeFakeZcode();
  const beforeBundle = readEntryText(fx.asar, "out/renderer/assets/index.js");
  const beforeLib = readEntryText(fx.asar, "vendor/extra/lib.js");

  const mainNew = Buffer.from(readEntryText(fx.asar, "out/main/index.js") + "\n// PATCHED\n", "utf8");
  const uiNew = Buffer.from("/* brand new file */\n", "utf8");
  const outFile = path.join(fx.resources, "app.asar.new");
  patchEntries(fx.asar, outFile, {
    "out/main/index.js": mainNew,
    "out/renderer/zcode-model-hub.js": uiNew,
  });

  assert.equal(readEntryText(outFile, "out/main/index.js"), readEntryText(fx.asar, "out/main/index.js") + "\n// PATCHED\n");
  assert.equal(readEntryText(outFile, "out/renderer/zcode-model-hub.js"), "/* brand new file */\n");
  // untouched entries keep exact bytes
  assert.equal(readEntryText(outFile, "out/renderer/assets/index.js"), beforeBundle);
  assert.equal(readEntryText(outFile, "vendor/extra/lib.js"), beforeLib);
  // sizes: data region preserved + appended
  const s1 = listFiles(fx.asar);
  const s2 = listFiles(outFile);
  assert.ok(s2.archiveSize > s1.archiveSize);
});

test("patchEntries with createMissing=false refuses new entries", () => {
  const fx = makeFakeZcode();
  const outFile = path.join(fx.resources, "app.asar.new2");
  assert.throws(
    () => patchEntries(fx.asar, outFile, { "nope/new.js": Buffer.from("x") }, { createMissing: false }),
    /missing entry/,
  );
});

test("unpack dir is preserved and unpacked entries cannot be patched", () => {
  const fx = makeFakeZcode({ withUnpacked: true });
  const unpackedFile = fx.asar + ".unpacked/vendor/native.node";
  assert.ok(fs.existsSync(unpackedFile));
  const outFile = path.join(fx.resources, "app2.asar");
  patchEntries(fx.asar, outFile, { "out/main/index.js": Buffer.from("zzz") });
  assert.ok(fs.existsSync(fx.asar + ".unpacked/vendor/native.node"), "original unpacked dir untouched");
  // header of patched archive still marks it unpacked
  const { files } = listFiles(outFile);
  const unp = files.find((f) => f.rel === "vendor/native.node");
  assert.equal(unp.unpacked, true);
  assert.throws(
    () => patchEntries(fx.asar, path.join(fx.resources, "app3.asar"), { "vendor/native.node": Buffer.from("no") }),
    /unpacked/,
  );
});

test("verifyPatchedArchive detects entry hash mismatches", () => {
  const fx = makeFakeZcode();
  const mainNew = Buffer.from("new main bytes", "utf8");
  const outFile = path.join(fx.resources, "v.asar");
  patchEntries(fx.asar, outFile, { "out/main/index.js": mainNew });
  const good = {};
  good["out/main/index.js"] = sha256Buf(mainNew);
  assert.equal(verifyPatchedArchive(outFile, good), true);
  const bad = { "out/main/index.js": "0".repeat(64) };
  assert.throws(() => verifyPatchedArchive(outFile, bad), /hash mismatch/);
});

test("peekHeader parses header without loading payload", () => {
  const fx = makeFakeZcode();
  const { json } = peekHeader(fx.asar);
  assert.ok(json.files["out"]);
});
