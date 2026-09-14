import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectAsarIntegrity, readAsarIntegrityFuses } from "../src/patch/asar-integrity.mjs";

function fuseWire(states, version = 1, count = states.length) {
  return Buffer.concat([
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([version, count]),
    Buffer.from(states),
  ]);
}

function bundleFixture(context, bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-fuses-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appBaseDir = path.join(directory, "ZCode.app");
  const binaryPath = path.join(appBaseDir, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(path.join(appBaseDir, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>fixture</string></dict></dict></dict></plist>');
  if (bytes !== undefined) fs.writeFileSync(binaryPath, bytes);
  return { appBaseDir, binaryPath };
}

test("plist metadata does not enable the disabled ASAR validation fuse", (context) => {
  const fixture = bundleFixture(context, fuseWire("101100011"));
  const before = fs.readFileSync(fixture.binaryPath);
  const result = inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" });
  assert.equal(result.status, "disabled");
  assert.equal(result.wires[0].count, 9);
  assert.equal(result.wires[0].enabled, false);
  assert.deepEqual(fs.readFileSync(fixture.binaryPath), before);
});

test("the actual fifth fuse enables validation even without plist metadata", (context) => {
  const fixture = bundleFixture(context, fuseWire("101110011"));
  fs.writeFileSync(path.join(fixture.appBaseDir, "Contents", "Info.plist"), '<plist version="1.0"><dict/></plist>');
  assert.equal(inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" }).status, "enabled");
});

test("all architectures are checked in a universal binary", (context) => {
  const fixture = bundleFixture(context, Buffer.concat([fuseWire("101100011"), Buffer.alloc(100), fuseWire("101110011")]));
  const result = inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" });
  assert.equal(result.status, "enabled");
  assert.deepEqual(result.wires.map((wire) => wire.enabled), [false, true]);
  fs.writeFileSync(fixture.binaryPath, Buffer.concat([fuseWire("101100011"), fuseWire("101100011")]));
  assert.equal(inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" }).status, "disabled");
});

test("a fuse sentinel crossing a scan boundary is still detected", (context) => {
  const padding = 4 * 1024 * 1024 - 10;
  const fixture = bundleFixture(context, Buffer.concat([Buffer.alloc(padding), fuseWire("101100011")]));
  const wires = readAsarIntegrityFuses(fixture.binaryPath);
  assert.equal(wires.length, 1);
  assert.equal(wires[0].offset, padding);
  assert.equal(wires[0].enabled, false);
});

test("unsupported, truncated, removed and missing fuse wires remain unknown", (context) => {
  const invalidBinaries = [
    fuseWire("101100011", 2),
    fuseWire("1011"),
    fuseWire("101100011", 1, 30),
    fuseWire("1011r0011"),
    Buffer.from("no fuse wire here"),
  ];
  for (const bytes of invalidBinaries) {
    const fixture = bundleFixture(context, bytes);
    const result = inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" });
    assert.equal(result.status, "unknown");
    assert.ok(result.error);
  }
});

test("a missing framework is not incorrectly reported as an enabled fuse", (context) => {
  const fixture = bundleFixture(context);
  const result = inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" });
  assert.equal(result.status, "unknown");
  assert.match(result.error, /ENOENT/);
});

test("an unexpected third architecture wire is not silently ignored", (context) => {
  const fixture = bundleFixture(context, Buffer.concat([fuseWire("101100011"), fuseWire("101100011"), fuseWire("101100011")]));
  assert.equal(inspectAsarIntegrity(fixture.appBaseDir, { platform: "darwin" }).status, "unknown");
});

test("non-macOS installs do not probe a macOS framework", (context) => {
  const fixture = bundleFixture(context, fuseWire("101110011"));
  assert.equal(inspectAsarIntegrity(fixture.appBaseDir, { platform: "linux" }).status, "not-applicable");
  assert.equal(inspectAsarIntegrity(fixture.appBaseDir, { platform: "win32" }).status, "not-applicable");
});
