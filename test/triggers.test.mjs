import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launchAgentPlist, windowsTaskAction, windowsTaskScript, linuxUnitContents } from "../src/repair/triggers.mjs";
import { appBaseDirFor } from "../src/platform.mjs";

test("macOS discovery returns the bundle rather than Contents", () => {
  const bundle = path.resolve("ZCode.app");
  assert.equal(appBaseDirFor(path.join(bundle, "Contents", "Resources"), "darwin"), bundle);
  assert.equal(appBaseDirFor(path.join(bundle, "resources"), "win32"), bundle);
});

test("macOS trigger pins resources and XML-escapes paths", () => {
  const archive = path.resolve("Example & Tools", "ZCode.app", "Contents", "Resources", "app.asar");
  const plist = launchAgentPlist(archive, { node: "/node", cli: "/project & tools/cli.mjs", log: "/log & output" });
  assert.match(plist, /<string>--resources<\/string>/);
  assert.ok(plist.includes(path.dirname(archive).replace(/&/g, "&amp;")));
  assert.ok(plist.includes("/project &amp; tools/cli.mjs"));
});

test("Windows scheduled tasks separate executable from quoted arguments", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Users\\O'Brien\\Model Hub\\cli.mjs";
  const resources = "C:\\Programs\\ZCode\\resources\\";
  const action = windowsTaskAction(node, cli, resources);
  assert.equal(action.execute, node);
  assert.ok(action.arguments.startsWith('"' + cli + '"'));
  assert.ok(action.arguments.includes('"--resources"'));
  assert.ok(action.arguments.endsWith('resources\\\\"'));
  const script = windowsTaskScript(action);
  assert.ok(script.includes("-Execute '" + node + "' -Argument '"));
  assert.ok(script.includes("O''Brien"));
  assert.ok(script.includes("$ErrorActionPreference = 'Stop'"));
  assert.doesNotMatch(script, /-Execute \$action/);
});

test("Linux uses independent startup and change triggers without PathExists", () => {
  const archive = path.resolve("ZCode Files", "resources", "app.asar");
  const units = linuxUnitContents(archive, { node: "/node path/node", cli: "/project path/cli.mjs" });
  assert.match(units.service, /Type=oneshot/);
  assert.match(units.service, /\[Install\]\nWantedBy=default.target/);
  assert.ok(units.service.includes('ExecStart="/node path/node" "/project path/cli.mjs"'));
  assert.ok(units.service.includes('"--resources"'));
  assert.ok(units.pathUnit.includes("PathChanged=" + archive));
  assert.doesNotMatch(units.pathUnit, /PathExists|PathExistsGlob|DirectoryNotEmpty/);
});
