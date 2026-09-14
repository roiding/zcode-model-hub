import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/zcode-model-hub.mjs", import.meta.url));
const successResponse = 'return new Response(JSON.stringify({ data: [{ id: "fetched-model" }] }));';

function runCli(context, argumentsList, config, { fetchBody = successResponse, emptyHome = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-cli-regression-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "User Space");
  const configPath = path.join(home, ".zcode", "v2", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    const configPath = ${JSON.stringify(configPath)};
    ${emptyHome ? `os.homedir = () => ${JSON.stringify(home)};` : ""}
    globalThis.fetch = async (url, options) => { ${fetchBody} };
    process.argv = [process.execPath, ${JSON.stringify(cliPath)}, ...${JSON.stringify(argumentsList)}];
    await import(${JSON.stringify(pathToFileURL(cliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory,
    env: { ...process.env, HOME: emptyHome ? "" : home, USERPROFILE: home, ZCODE_MODEL_HUB_STATE_DIR: path.join(directory, "state") },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.ifError(result.error);
  return { ...result, config: JSON.parse(fs.readFileSync(configPath, "utf8")) };
}

test("sync --all --json syncs every provider and emits only JSON", (context) => {
  const result = runCli(context, ["sync", "--all", "--json"], { provider: {
    first: { options: { baseURL: "https://first.invalid" } },
    second: { options: { baseURL: "https://second.invalid" } },
  } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.length, 2);
  assert.ok(output.every((provider) => provider.ok));
  assert.ok(result.config.provider.first.models["fetched-model"]);
  assert.ok(result.config.provider.second.models["fetched-model"]);
});

test("failed JSON sync reports an error and exits unsuccessfully", (context) => {
  const result = runCli(context, ["sync", "--provider", "demo", "--json"], { provider: { demo: { options: { baseURL: "https://bad.invalid" } } } }, {
    fetchBody: 'return new Response("unauthorized", { status: 401 });',
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output[0].ok, false);
  assert.match(output[0].error, /HTTP 401/);
  assert.equal(result.config.provider.demo.models, undefined);
});

test("failed human-readable sync exits unsuccessfully", (context) => {
  const result = runCli(context, ["sync", "--all"], { provider: { demo: { options: { baseURL: "https://bad.invalid" } } } }, {
    fetchBody: 'return new Response("unauthorized", { status: 401 });',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /失败/);
  assert.match(result.stderr, /HTTP 401/);
});

test("partially failed sync saves successes but returns failure", (context) => {
  const result = runCli(context, ["sync", "--all", "--json"], { provider: {
    bad: { options: { baseURL: "https://bad.invalid" } },
    good: { options: { baseURL: "https://good.invalid" } },
  } }, { fetchBody: 'if (new URL(url).hostname === "bad.invalid") return new Response("unauthorized", { status: 401 }); ' + successResponse });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).map((provider) => provider.ok), [false, true]);
  assert.ok(result.config.provider.good.models["fetched-model"]);
});

test("CLI uses homedir rather than HOME or the working directory", (context) => {
  const result = runCli(context, ["sync", "--list", "--json"], { provider: { demo: { options: { baseURL: "https://provider.invalid", apiKey: "FAKE-SECRET" } } } }, { emptyHome: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].id, "demo");
  assert.ok(!result.stdout.includes("FAKE-SECRET"));
});

test("CLI preserves concurrent non-model configuration changes", (context) => {
  const result = runCli(context, ["sync", "--provider", "demo"], { theme: "before", provider: { demo: { options: { baseURL: "https://provider.invalid" } } } }, {
    fetchBody: 'const fresh = JSON.parse(fs.readFileSync(configPath, "utf8")); fresh.theme = "after"; fresh.provider.concurrent = { models: { keep: {} } }; fs.writeFileSync(configPath, JSON.stringify(fresh)); ' + successResponse,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.config.theme, "after");
  assert.ok(result.config.provider.concurrent.models.keep);
  assert.ok(result.config.provider.demo.models["fetched-model"]);
});
