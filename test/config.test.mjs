import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readConfig, listProviders, writeConfigAtomic, mergeFetchedModels, defaultModelEntry } from "../src/config.mjs";

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
