import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const clone = (value) => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = "";
    this.className = "";
    this.ownText = "";
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get innerText() { return this.textContent; }
  set innerHTML(value) { this.children = []; this.ownText = value; }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getBoundingClientRect() { return { width: 100, height: 20, left: 500, top: 300, right: 600 }; }
  addEventListener(event, handler) { (this.listeners[event] ||= []).push(handler); }
  dispatch(event) { for (const handler of this.listeners[event] || []) handler({ stopPropagation() {}, preventDefault() {} }); }
  click() { if (!this.disabled) this.dispatch("click"); }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (selectors.some((part) => {
          const tag = part.match(/^[a-z0-9]+/i)?.[0];
          if (tag && child.tagName !== tag.toUpperCase()) return false;
          const classPart = part.match(/class\*=['"]([^'"]+)['"]/);
          return !classPart || child.className.includes(classPart[1]);
        })) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function renderer(config, models = [{ id: "first" }, { id: "last" }], vision = true) {
  let current = clone(config);
  const writes = [];
  const requests = [];
  const probes = [];
  const body = new Element("body");
  const document = {
    body,
    readyState: "loading",
    addEventListener() {},
    createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  const bridge = {
    readConfig: async () => ({ ok: true, data: clone(current) }),
    writeConfig: async (next) => { current = clone(next); writes.push(clone(next)); return { ok: true }; },
    fetchModels: async (baseUrl, apiKey, options) => {
      requests.push({ baseUrl, apiKey, options: clone(options) });
      return { ok: true, dialect: "openai", models: clone(models) };
    },
    probeVision: async (baseUrl, apiKey, model, options) => {
      probes.push({ baseUrl, apiKey, model, options: clone(options) });
      return { ok: true, vision };
    },
  };
  const context = vm.createContext({
    document, console, URL,
    window: { zcodeModelHub: bridge, matchMedia: () => ({ matches: false }), innerWidth: 1400 },
    setTimeout: () => 0,
    location: { reload() {} },
  });
  const source = fs.readFileSync(new URL("../src/patch/snippets/ui/zcode-model-hub.js", import.meta.url), "utf8");
  vm.runInContext(source.replace("  // ---- boot ----", "  globalThis.ui = { openModal, openHeadersModal, ensureProviderEntry, findProviderByBaseUrl, providerReference, onPullClick, mergeFinalState };\n  // ---- boot ----"), context);
  return {
    ui: context.ui, body, writes, requests, probes,
    button: (text) => body.querySelectorAll("button").find((element) => element.textContent === text),
    config: () => clone(current),
    setConfig: (next) => { current = clone(next); },
    flush: async () => { await new Promise(setImmediate); await new Promise(setImmediate); },
  };
}

test("saving a new provider preserves every existing array provider", async () => {
  const existing = { id: "old", options: { baseURL: "https://old.invalid", apiKey: "FAKE-OLD" }, models: { manual: {} } };
  const harness = renderer({ provider: [existing] });
  harness.ui.openModal({ dialect: "openai", models: [{ id: "new-model" }] }, { baseUrl: "https://new.invalid", apiKey: "FAKE-NEW", name: "new" }, []);
  harness.button("确认添加并保存").click();
  await harness.flush();
  const saved = harness.config();
  assert.ok(Array.isArray(saved.provider));
  assert.equal(saved.provider.length, 2);
  assert.deepEqual(saved.provider[0], existing);
  assert.ok(saved.provider[1].models["new-model"]);
});

test("new provider names cannot overwrite another provider", () => {
  const config = { provider: { demo: { options: { baseURL: "https://old.invalid" } } } };
  const harness = renderer(config);
  const added = harness.ui.ensureProviderEntry(config, { name: "demo", baseUrl: "https://new.invalid" });
  assert.notEqual(added.key, "demo");
  assert.equal(config.provider.demo.options.baseURL, "https://old.invalid");
  assert.equal(added.p.options.baseURL, "https://new.invalid");
});

test("checkbox changes update only their own model and persist final selection", async () => {
  const harness = renderer({ provider: { demo: { options: { baseURL: "https://provider.invalid" }, models: { first: {}, last: {} } } } });
  harness.ui.openModal({ dialect: "openai", models: [{ id: "first" }, { id: "last" }] }, { baseUrl: "https://provider.invalid" }, ["first", "last"]);
  const checkboxes = harness.body.querySelectorAll("input").filter((input) => input.type === "checkbox");
  checkboxes[0].checked = false;
  checkboxes[0].dispatch("change");
  harness.button("确认添加并保存").click();
  await harness.flush();
  assert.deepEqual(Object.keys(harness.config().provider.demo.models), ["last"]);
  assert.deepEqual(harness.config().zcode.deletedModels, ["first"]);
});

test("shared gateway providers are disambiguated by credentials and stable identity", async () => {
  const config = { provider: {
    accountA: { options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-A" }, models: { untouched: {} } },
    accountB: { options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-B" }, models: {} },
  } };
  const harness = renderer(config);
  const credentials = { baseUrl: "https://gateway.invalid", apiKey: "FAKE-B" };
  const selected = harness.ui.findProviderByBaseUrl(config, credentials.baseUrl, credentials);
  assert.equal(selected.key, "accountB");
  credentials.providerRef = harness.ui.providerReference(selected);
  harness.ui.openModal({ dialect: "openai", models: [{ id: "new-model" }] }, credentials, []);
  harness.button("确认添加并保存").click();
  await harness.flush();
  assert.deepEqual(harness.config().provider.accountA, config.provider.accountA);
  assert.ok(harness.config().provider.accountB.models["new-model"]);
});

test("ambiguous shared gateway identities are rejected instead of choosing the first", () => {
  const config = { provider: {
    accountA: { name: "Account A", options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-KEY" } },
    accountB: { name: "Account B", options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-KEY" } },
  } };
  const harness = renderer(config);
  assert.throws(() => harness.ui.findProviderByBaseUrl(config, "https://gateway.invalid", { apiKey: "FAKE-KEY" }), /多个供应商/);
  assert.equal(harness.ui.findProviderByBaseUrl(config, "https://gateway.invalid", { apiKey: "FAKE-KEY", name: "Account B" }).key, "accountB");
  assert.throws(() => harness.ui.findProviderByBaseUrl(config, "https://gateway.invalid", { apiKey: "FAKE-NEW" }), /先保存/);
});

test("a modal cannot recreate its provider after it is deleted", async () => {
  const config = { provider: { demo: { options: { baseURL: "https://provider.invalid" }, models: {} } } };
  const harness = renderer(config);
  const reference = harness.ui.providerReference(harness.ui.findProviderByBaseUrl(config, "https://provider.invalid"));
  harness.ui.openModal({ dialect: "openai", models: [{ id: "new-model" }] }, { baseUrl: "https://provider.invalid", providerRef: reference }, []);
  harness.setConfig({ provider: {} });
  harness.button("确认添加并保存").click();
  await harness.flush();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.body.textContent, /供应商已变更或被删除/);
});

test("pull and probe carry custom headers and persist explicit vision results", async () => {
  const config = {
    provider: {
      demo: {
        options: { baseURL: "https://provider.invalid", apiKey: "FAKE-KEY" },
        headers: { "x-app": "cli" },
        models: {
          first: {
            name: "Custom label",
            limit: { context: 4096 },
            modalities: { input: ["text", "audio"], output: ["text"] },
          },
        },
      },
    },
  };
  const harness = renderer(config, [{ id: "first", visionGuess: false }]);
  harness.ui.onPullClick(new Element("button"));
  await harness.flush();
  assert.equal(harness.requests[0].options.headers["x-app"], "cli");
  harness.button("探测视觉(勾选)").click();
  await harness.flush();
  assert.equal(harness.probes[0].options.headers["x-app"], "cli");
  assert.equal(harness.probes[0].options.dialect, "openai");
  harness.button("确认添加并保存").click();
  await harness.flush();
  const model = harness.config().provider.demo.models.first;
  assert.deepEqual(model.modalities.input, ["text", "audio", "image"]);
  assert.equal(model.name, "Custom label");
  assert.equal(model.limit.context, 4096);
});

test("vision guesses preserve existing modalities while explicit negative probes remove image", () => {
  const config = { provider: { demo: { models: { first: { modalities: { input: ["text", "image", "audio"], output: ["audio"] } } } } } };
  const harness = renderer(config);
  harness.ui.mergeFinalState(config, config.provider.demo, [{ id: "first", visionGuess: false }], ["first"]);
  assert.deepEqual(clone(config.provider.demo.models.first.modalities.input), ["text", "image", "audio"]);
  harness.ui.mergeFinalState(config, config.provider.demo, [{ id: "first", visionGuess: false, visionProbed: true }], ["first"]);
  assert.deepEqual(clone(config.provider.demo.models.first.modalities), { input: ["text", "audio"], output: ["audio"] });
});

test("vision probe updates do not mutate inherited model properties", () => {
  const config = { provider: { demo: { models: {} } } };
  const harness = renderer(config);
  harness.ui.mergeFinalState(config, config.provider.demo, [{ id: "__proto__", visionGuess: true, visionProbed: true }], ["__proto__"]);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "modalities"), false);
});

test("header editor writes only the captured provider on a shared gateway", async () => {
  const config = { provider: {
    accountA: { options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-A" }, headers: { untouched: "yes" } },
    accountB: { options: { baseURL: "https://gateway.invalid", apiKey: "FAKE-B" } },
  } };
  const harness = renderer(config);
  const credentials = { baseUrl: "https://gateway.invalid", apiKey: "FAKE-B" };
  const selected = harness.ui.findProviderByBaseUrl(config, credentials.baseUrl, credentials);
  credentials.providerRef = harness.ui.providerReference(selected);
  harness.ui.openHeadersModal(selected, credentials, config);
  harness.button("Claude Code (claude-cli)").click();
  harness.button("应用并保存").click();
  await harness.flush();
  assert.deepEqual(harness.config().provider.accountA.headers, { untouched: "yes" });
  assert.equal(harness.config().provider.accountB.headers["x-app"], "cli");
});
