import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { EventEmitter } from "node:events";

async function mainHandlers({ home, redirect } = {}) {
  const handlers = new Map();
  const requests = [];
  const transport = {
    request(url, options, onResponse) {
      requests.push({ url: url.href, ...options });
      const request = new EventEmitter();
      request.write = () => {};
      request.destroy = (error) => { if (error) request.emit("error", error); };
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.resume = () => {};
        const location = redirect && redirect(url);
        response.statusCode = location ? 302 : 200;
        response.headers = location ? { location } : {};
        onResponse(response);
        if (!location) {
          response.emit("data", Buffer.from(JSON.stringify({ data: [{ id: "model" }] })));
          response.emit("end");
        }
      });
      return request;
    },
  };
  const context = vm.createContext({
    Buffer, URL, console,
    loadModule: async (name) => {
      if (name === "electron") return { ipcMain: { removeHandler() {}, handle(channel, handler) { handlers.set(channel, handler); } } };
      if (name === "node:http" || name === "node:https") return { default: transport };
      if (name === "node:os" && home) return { default: { homedir: () => home } };
      return import(name);
    },
  });
  const source = fs.readFileSync(new URL("../src/patch/snippets/main-handlers.js", import.meta.url), "utf8");
  await vm.runInContext(source.replaceAll("await import(", "await loadModule("), context);
  return { requests, invoke: (name, payload) => handlers.get(`modelhub:${name}`)({}, payload) };
}

test("main transport blocks credentials from cross-origin and downgraded redirects", async () => {
  for (const location of ["https://other.invalid/models", "http://provider.invalid/models"]) {
    const main = await mainHandlers({ redirect: () => location });
    const result = await main.invoke("fetch-models", { baseUrl: "https://provider.invalid", apiKey: "FAKE-KEY", headers: { private: "FAKE-PRIVATE" }, dialect: "anthropic" });
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked.*redirect/);
    assert.equal(main.requests.length, 1);
    assert.equal(main.requests[0].headers["x-api-key"], "FAKE-KEY");
  }
});

test("main transport allows same-origin GET redirects and preserves headers", async () => {
  const main = await mainHandlers({ redirect: (url) => url.pathname === "/v1/models" ? "/catalog" : null });
  const result = await main.invoke("fetch-models", { baseUrl: "https://provider.invalid", apiKey: "FAKE-KEY", headers: { "x-app": "cli" }, dialect: "anthropic" });
  assert.equal(result.ok, true);
  assert.equal(main.requests.length, 2);
  assert.equal(main.requests[1].url, "https://provider.invalid/catalog");
  assert.equal(main.requests[1].headers["x-app"], "cli");
});

test("main transport bounds redirect loops and does not replay probe POSTs", async () => {
  const looping = await mainHandlers({ redirect: () => "/v1/models" });
  const models = await looping.invoke("fetch-models", { baseUrl: "https://provider.invalid", dialect: "anthropic" });
  assert.equal(models.ok, false);
  assert.match(models.error, /too many redirects/);
  assert.equal(looping.requests.length, 4);
  const probing = await mainHandlers({ redirect: () => "/other" });
  const result = await probing.invoke("probe-vision", { baseUrl: "https://provider.invalid", apiKey: "FAKE-KEY", model: "model", dialect: "anthropic" });
  assert.equal(result.ok, false);
  assert.match(result.error, /blocked redirect/);
  assert.equal(probing.requests.length, 1);
});

test("main config writer keeps credential files private", { skip: process.platform === "win32" }, async (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-main-config-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".zcode", "v2", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"provider":{}}', { mode: 0o600 });
  const main = await mainHandlers({ home });
  const result = await main.invoke("write-config", { provider: { demo: { apiKey: "FAKE-KEY" } } });
  assert.equal(result.ok, true);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(configPath + ".model-hub.bak").mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(configPath)).some((name) => name.endsWith(".tmp")), false);
});
