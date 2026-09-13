// ~/.zcode/v2/config.json — atomic reads/writes + provider/model merge logic.
// The provider section is handled defensively: object-map or array shapes,
// kind: anthropic | openai | openai-compatible, options: { apiKey, baseURL }.
import fs from "node:fs";
import path from "node:path";
import { zcodeConfigPath } from "./platform.mjs";
import { atomicWriteBuffer } from "./archive/verify.mjs";

export function readConfig(configPath = zcodeConfigPath()) {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`config.json unreadable (${configPath}): ${e.message}`);
  }
}

export function writeConfigAtomic(cfg, configPath = zcodeConfigPath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    const bak = configPath + ".model-hub.bak";
    fs.rmSync(bak + ".model-hub-tmp", { force: true });
    fs.copyFileSync(configPath, bak + ".model-hub-tmp");
    fs.renameSync(bak + ".model-hub-tmp", bak);
  }
  atomicWriteBuffer(configPath, Buffer.from(JSON.stringify(cfg, null, 2), "utf8"));
}

// Normalize the provider section into [{ key, id, kind, baseURL, apiKey, models }].
export function listProviders(cfg) {
  const section = cfg?.provider;
  const out = [];
  const push = (key, id, p) => {
    if (!p || typeof p !== "object") return;
    const opts = p.options || {};
    out.push({
      key,
      id: p.id || id || key,
      name: p.name || id || key,
      kind: p.kind || "openai-compatible",
      baseURL: opts.baseURL || p.baseURL || "",
      apiKey: opts.apiKey || p.apiKey || "",
      models: p.models || {},
    });
  };
  if (Array.isArray(section)) {
    section.forEach((p, i) => push(i, p?.id ?? p?.name, p));
  } else if (section && typeof section === "object") {
    for (const [key, p] of Object.entries(section)) push(key, key, p);
  }
  return out;
}

function providerSection(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("config root is not an object");
  if (cfg.provider === undefined) cfg.provider = {};
  return cfg.provider;
}

function getProviderEntry(cfg, key) {
  const section = providerSection(cfg);
  if (Array.isArray(section)) {
    const idx = section.findIndex((p) => p && (p.id === key || p.name === key || String(section.indexOf(p)) === key));
    return { container: section, idx };
  }
  if (section && typeof section === "object") {
    if (!Object.prototype.hasOwnProperty.call(section, key)) section[key] = {};
    return { container: section, key };
  }
  throw new Error("unsupported provider section type");
}

function setProviderModel(container, keyOrIdx, modelId, entry) {
  const p = Array.isArray(container) ? container[keyOrIdx] : container[keyOrIdx];
  if (!p.models || typeof p.models !== "object" || Array.isArray(p.models)) p.models = {};
  p.models[modelId] = entry;
}

function deleteProviderModel(container, keyOrIdx, modelId) {
  const p = Array.isArray(container) ? container[keyOrIdx] : container[keyOrIdx];
  if (p.models && typeof p.models === "object" && !Array.isArray(p.models)) delete p.models[modelId];
}

function deletedModelsSet(cfg) {
  if (!cfg.zcode || typeof cfg.zcode !== "object") cfg.zcode = {};
  if (!Array.isArray(cfg.zcode.deletedModels)) cfg.zcode.deletedModels = [];
  return new Set(cfg.zcode.deletedModels);
}

export function defaultModelEntry(id, vision) {
  return {
    name: id,
    limit: { context: 128000, output: 8192 },
    modalities: {
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

// Merge fetched models into one provider.
// semantics (aligned with modelhub-patch "final state"):
//   - fetched & selected  -> present (existing entry object preserved if any)
//   - fetched & unselected-> removed from provider.models AND recorded in
//                           zcode.deletedModels so later syncs don't resurrect
//   - manual models (not in the fetched list) are always preserved
//   - a model present in deletedModels that gets re-selected is un-deleted
export function mergeFetchedModels(cfg, providerKey, fetched, { selected } = {}) {
  const deleted = deletedModelsSet(cfg);
  // Union sync (selected undefined) never resurrects tombstoned models;
  // an explicit selection (UI confirm) is user intent and un-deletes them.
  const want = new Set(
    selected === undefined
      ? fetched.filter((f) => !deleted.has(f.id)).map((f) => f.id)
      : selected,
  );
  const { container, key, idx } = getProviderEntry(cfg, providerKey);
  const p = Array.isArray(container) ? container[idx] : container[key];
  const existingIds = new Set(Object.keys(p.models || {}));
  const manualIds = [...existingIds].filter((id) => !fetched.some((f) => f.id === id));

  for (const f of fetched) {
    if (!want.has(f.id)) continue;
    deleted.delete(f.id);
    if (!p.models || !p.models[f.id])
      setProviderModel(container, Array.isArray(container) ? idx : key, f.id, defaultModelEntry(f.id, f.visionGuess));
  }
  for (const id of Object.keys(p.models || {})) {
    const isFetched = fetched.some((f) => f.id === id);
    if (isFetched && !want.has(id)) {
      deleteProviderModel(container, Array.isArray(container) ? idx : key, id);
      deleted.add(id);
    }
  }
  for (const id of manualIds) deleted.delete(id); // manual models always win

  cfg.zcode.deletedModels = [...deleted].sort();
  return { added: fetched.filter((f) => want.has(f.id) && !existingIds.has(f.id)).map((f) => f.id) };
}

// Pull-models entry used by the CLI: fetch + merge + write in one shot.
export async function syncProvider(cfg, provider, { dialect, selected, timeoutMs } = {}) {
  const { fetchModels } = await import("./providers/index.mjs");
  if (!provider.baseURL) throw new Error(`provider ${provider.id} has no baseURL`);
  const res = await fetchModels(provider.baseURL, provider.apiKey, { dialect, timeoutMs });
  if (!res.ok) return res;
  const merge = mergeFetchedModels(cfg, provider.key, res.models, { selected });
  return { ok: true, dialect: res.dialect, total: res.models.length, added: merge.added, models: res.models };
}
