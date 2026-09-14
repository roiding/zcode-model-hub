import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBase,
  candidatesFor,
  authHeaders,
  guessDialect,
  parseModelsResponse,
  visionGuess,
  redactUrl,
  fetchModels,
  probeVision,
} from "../src/providers/index.mjs";

test("normalizeBase strips trailing slashes", () => {
  assert.equal(normalizeBase(" https://api.x.com/v1/ "), "https://api.x.com/v1");
});

test("candidatesFor openai tries /v1/models first, tolerates /v1-suffixed base", () => {
  assert.deepEqual(candidatesFor("openai", "https://a.com"), ["https://a.com/v1/models", "https://a.com/models"]);
  assert.deepEqual(candidatesFor("openai", "https://a.com/v1"), ["https://a.com/v1/models", "https://a.com/models"]);
  assert.deepEqual(candidatesFor("openai", "https://a.com/api"), ["https://a.com/api/v1/models", "https://a.com/api/models", "https://a.com/v1/models"]);
});

test("candidatesFor anthropic/gemini", () => {
  assert.deepEqual(candidatesFor("anthropic", "https://a.com"), ["https://a.com/v1/models"]);
  assert.deepEqual(candidatesFor("anthropic", "https://a.com/v1"), ["https://a.com/v1/models"]);
  assert.deepEqual(candidatesFor("gemini", "https://g.com"), ["https://g.com/v1beta/models"]);
  assert.deepEqual(candidatesFor("gemini", "https://g.com/v1beta"), ["https://g.com/v1beta/models"]);
});

test("authHeaders per dialect (no key leakage into logs is handled elsewhere)", () => {
  const oa = authHeaders("openai", "sk-test");
  assert.equal(oa.Authorization, "Bearer sk-test");
  const an = authHeaders("anthropic", "sk-test");
  assert.equal(an["x-api-key"], "sk-test");
  assert.equal(an["anthropic-version"], "2023-06-01");
  const ge = authHeaders("gemini", "g-key");
  assert.equal(ge["x-goog-api-key"], "g-key");
  const extra = authHeaders("openai", undefined, { "X-Mock": "claude-cli" });
  assert.equal(extra["X-Mock"], "claude-cli");
  assert.equal(extra.Authorization, undefined);
});

test("guessDialect", () => {
  assert.equal(guessDialect("https://api.anthropic.com"), "anthropic");
  assert.equal(guessDialect("https://generativelanguage.googleapis.com"), "gemini");
  assert.equal(guessDialect("https://oneapi.example.com/v1"), "openai");
});

test("parseModelsResponse handles the shapes seen in the wild", () => {
  assert.deepEqual(
    parseModelsResponse("openai", { data: [{ id: "b" }, { id: "a" }, { id: "a" }] }).map((m) => m.id),
    ["a", "b"],
  );
  assert.deepEqual(
    parseModelsResponse("openai", ["m1", { id: "m2" }]).map((m) => m.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    parseModelsResponse("gemini", { models: [{ name: "models/gemini-x" }] }).map((m) => m.id),
    ["gemini-x"],
  );
  assert.deepEqual(parseModelsResponse("openai", { nothing: 1 }), []);
});

test("visionGuess + redactUrl", () => {
  assert.equal(visionGuess("glm-4v-plus"), true);
  assert.equal(visionGuess("gpt-4o-mini"), true);
  assert.equal(visionGuess("deepseek-chat"), false);
  assert.equal(redactUrl("https://g.com/v1beta/models?key=SECRET"), "https://g.com/v1beta/models?key=***");
});

function stalledResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      const abort = () => controller.error(new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  }));
}

test("model request timeout covers the response body", { timeout: 2000 }, async (context) => {
  const signals = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    signals.push(options.signal);
    return stalledResponse(options.signal);
  });
  const result = await fetchModels("https://provider.invalid", "FAKE-KEY", { dialect: "anthropic", timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("vision request timeout covers the response body", { timeout: 2000 }, async (context) => {
  context.mock.method(globalThis, "fetch", async (url, options) => stalledResponse(options.signal));
  const result = await probeVision("https://provider.invalid", "FAKE-KEY", "model", { dialect: "openai", timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
});

test("already aborted model request never reaches the transport", async (context) => {
  const request = context.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  const controller = new AbortController();
  controller.abort();
  const result = await fetchModels("https://provider.invalid", "FAKE-KEY", { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(request.mock.callCount(), 0);
});

test("credentialed model requests refuse cross-origin and downgrade redirects", async (context) => {
  for (const location of ["https://other.invalid/models", "http://provider.invalid/models"]) {
    const requests = [];
    const mocked = context.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "manual");
      return new Response(null, { status: 302, headers: { location } });
    });
    const result = await fetchModels("https://provider.invalid", "FAKE-KEY", { dialect: "anthropic" });
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked.*redirect/);
    assert.equal(requests.length, 1);
    mocked.mock.restore();
  }
});

test("same-origin GET redirects retain custom headers", async (context) => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    assert.equal(options.headers["x-app"], "cli");
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: "/catalog" } });
    return new Response(JSON.stringify({ data: [{ id: "redirected-model" }] }));
  });
  const result = await fetchModels("https://provider.invalid", "FAKE-KEY", { dialect: "anthropic", headers: { "x-app": "cli" } });
  assert.equal(result.ok, true);
  assert.equal(requests[1], "https://provider.invalid/catalog");
});

test("vision POST requests are not replayed after redirects", async (context) => {
  const request = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 307, headers: { location: "/other" } }));
  const result = await probeVision("https://provider.invalid", "FAKE-KEY", "model", { dialect: "anthropic" });
  assert.equal(result.ok, false);
  assert.match(result.error, /blocked redirect/);
  assert.equal(request.mock.callCount(), 1);
});
