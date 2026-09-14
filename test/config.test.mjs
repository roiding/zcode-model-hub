import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readConfig, listProviders, writeConfigAtomic, mergeFetchedModels, defaultModelEntry, syncProvider } from "../src/config.mjs";

test("listProviders handles object-map and array shapes", () => {
  const map = {
    provider: {
      ds: { kind: "openai", options: { baseURL: "https://api.deepseek.com", apiKey: "k1" }, models: { "deepseek-chat": {} } },
    },
  };
  const [p1] = listProviders(map);
  assert.equal(p1.id, "ds");
  assert.equal(p1.baseURL, "https://api.deepseek.com");
  assert.equal(p1.models && Object.keys(p1.models)[0], "deepseek-chat");

  const arr = { provider: [{ id: "x", options: { baseURL: "https://x.io" } }] };
  const [p2] = listProviders(arr);
  assert.equal(p2.key, 0);
  assert.equal(p2.baseURL, "https://x.io");
});

test("mergeFetchedModels: union add, final-state prune, deletedModels persistence", () => {
  const cfg = {
    provider: {
      p: {
        kind: "openai-compatible",
        options: { baseURL: "https://a.com", apiKey: "k" },
        models: { "deepseek-chat": { name: "deepseek-chat" }, "manual-model": { name: "manual-model" } },
      },
    },
  };
  const fetched = [
    { id: "deepseek-chat", visionGuess: false },
    { id: "new-model", visionGuess: true },
    { id: "to-drop", visionGuess: false },
  ];

  // add all (union with existing manual models)
  let r = mergeFetchedModels(cfg, "p", fetched);
  assert.deepEqual(r.added.sort(), ["new-model", "to-drop"]);
  const p = cfg.provider.p;
  assert.ok(p.models["deepseek-chat"]); // existing entry preserved by reference
  assert.ok(p.models["manual-model"]); // manual survives
  assert.ok(p.models["to-drop"]);
  assert.deepEqual(p.models["new-model"].modalities.input, ["text", "image"]); // vision default

  // final state: drop "to-drop" -> recorded in deletedModels
  r = mergeFetchedModels(cfg, "p", fetched, { selected: ["deepseek-chat", "new-model"] });
  assert.ok(!p.models["to-drop"]);
  assert.ok(cfg.zcode.deletedModels.includes("to-drop"));
  assert.ok(p.models["manual-model"]);

  // a later sync does not resurrect deleted models (they are simply not re-added)
  mergeFetchedModels(cfg, "p", fetched);
  assert.ok(!p.models["to-drop"]);

  // re-selecting a deleted model un-deletes it
  mergeFetchedModels(cfg, "p", fetched, { selected: ["deepseek-chat", "new-model", "to-drop"] });
  assert.ok(p.models["to-drop"]);
  assert.ok(!cfg.zcode.deletedModels.includes("to-drop"));
  assert.ok(p.models["manual-model"]);
});

test("defaultModelEntry vision flag", () => {
  assert.deepEqual(defaultModelEntry("a", true).modalities.input, ["text", "image"]);
  assert.deepEqual(defaultModelEntry("a", false).modalities.input, ["text"]);
});

test("writeConfigAtomic leaves a .model-hub.bak and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ provider: {} }));
  writeConfigAtomic({ provider: { a: { options: { baseURL: "https://a.com" } } } }, file);
  const cfg = readConfig(file);
  assert.ok(cfg.provider.a);
  assert.ok(fs.existsSync(file + ".model-hub.bak"));
});

function configFixture(context, config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-config-regression-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test("array providers round-trip numeric keys through model merging", () => {
  const config = { provider: [{ id: "first", models: {} }, { name: "second", models: {} }] };
  for (const provider of listProviders(config)) {
    mergeFetchedModels(config, provider.key, [{ id: `model-${provider.key}` }]);
    assert.ok(config.provider[provider.key].models[`model-${provider.key}`]);
  }
  assert.throws(() => mergeFetchedModels(config, 99, [{ id: "missing" }]), /provider not found/);
});

test("sync forwards headers and preserves changes made during fetch", async (context) => {
  const config = { theme: "before", provider: { demo: { options: { baseURL: "https://provider.invalid", apiKey: "FAKE-KEY" }, headers: { "x-app": "cli" } } } };
  const file = configFixture(context, config);
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers["x-app"], "cli");
    const changed = readConfig(file);
    changed.theme = "after";
    changed.provider.other = { models: { manual: { name: "manual" } } };
    fs.writeFileSync(file, JSON.stringify(changed));
    return new Response(JSON.stringify({ data: [{ id: "new-model" }] }));
  });
  const result = await syncProvider(config, listProviders(config)[0], { configPath: file });
  const saved = readConfig(file);
  assert.equal(result.ok, true);
  assert.equal(saved.theme, "after");
  assert.ok(saved.provider.other.models.manual);
  assert.ok(saved.provider.demo.models["new-model"]);
  assert.deepEqual(result.added, ["new-model"]);
});

test("sync follows stable array IDs after reordering", async (context) => {
  const config = { provider: [
    { id: "first", options: { baseURL: "https://first.invalid" } },
    { id: "second", options: { baseURL: "https://second.invalid" } },
  ] };
  const file = configFixture(context, config);
  context.mock.method(globalThis, "fetch", async () => {
    fs.writeFileSync(file, JSON.stringify({ provider: [...config.provider].reverse() }));
    return new Response(JSON.stringify({ data: [{ id: "new-model" }] }));
  });
  await syncProvider(config, listProviders(config)[0], { configPath: file });
  const saved = readConfig(file);
  assert.equal(saved.provider[1].id, "first");
  assert.ok(saved.provider[1].models["new-model"]);
  assert.equal(saved.provider[0].models, undefined);
});

test("sync refuses to recreate a provider deleted during fetch", async (context) => {
  const config = { provider: { demo: { options: { baseURL: "https://provider.invalid" } } } };
  const file = configFixture(context, config);
  context.mock.method(globalThis, "fetch", async () => {
    fs.writeFileSync(file, '{"provider":{}}');
    return new Response(JSON.stringify({ data: [{ id: "new-model" }] }));
  });
  await assert.rejects(() => syncProvider(config, listProviders(config)[0], { configPath: file }), /changed or was removed/);
  assert.deepEqual(readConfig(file), { provider: {} });
});

test("configuration and backup permissions remain private", { skip: process.platform === "win32" }, (context) => {
  const file = configFixture(context, { provider: {} });
  fs.chmodSync(file, 0o600);
  writeConfigAtomic({ provider: { demo: { apiKey: "FAKE-KEY" } } }, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file + ".model-hub.bak").mode & 0o777, 0o600);
});

test("configuration save detects a conflict immediately before replacement", (context) => {
  const file = configFixture(context, { value: "before" });
  const expectedContent = fs.readFileSync(file, "utf8");
  const originalFsync = fs.fsyncSync;
  let changed = false;
  context.mock.method(fs, "fsyncSync", (descriptor) => {
    originalFsync(descriptor);
    if (!changed) {
      changed = true;
      fs.writeFileSync(file, '{"value":"concurrent"}');
    }
  });
  assert.throws(() => writeConfigAtomic({ value: "stale" }, file, { expectedContent }), /changed during save/);
  assert.equal(readConfig(file).value, "concurrent");
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});
