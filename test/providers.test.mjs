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
