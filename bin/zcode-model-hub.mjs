#!/usr/bin/env node
// zcode-model-hub — cross-platform, update-resilient model pulling for ZCode.
// Zero npm dependencies. Node >= 18 required (global fetch).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { OS as platform } from "../src/platform.mjs";

const VERSION = "0.1.0";

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resources") opts.resources = argv[++i];
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--dialect") opts.dialect = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--force-close") opts.forceClose = true;
    else if (a === "--no-watch") opts.noWatch = true;
    else if (a === "--no-skill") opts.noSkill = true;
    else if (a === "--quiet" || a === "-q") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--check-only") opts.checkOnly = true;
    else if (a === "--version" || a === "-V") opts.version = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "ensure" || a === "install" || a === "restore" || a === "status" || a === "doctor" || a === "sync" || a === "watch" || a === "unwatch")
      rest.push(a);
    else rest.push(a);
  }
  return { opts, cmd: rest[0] || null };
}

function mustNode18() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) throw new Error(`需要 Node.js >= 18（当前 ${process.versions.node}），CLI 层使用内置 fetch`);
}

const HELP = `zcode-model-hub v${VERSION} — 为 ZCode 桌面版拉取自定义供应商模型列表

用法: zcode-model-hub <命令> [选项]

命令:
  install     注入 UI 补丁（自动备份 + 手术式重打包），默认同时注册自动修复触发器
  restore     还原官方原版 app.asar
  status      三层状态一览（CLI 层 / 注入层 / 触发器）
  doctor      深度只读体检，失败时生成兼容性报告
  ensure      一次性自愈检查（触发器内部调用；快路径仅一次 stat）
  sync        用户空间模型同步（不修改 app.asar，更新免疫）
  watch       仅注册自动修复触发器
  unwatch     卸载自动修复触发器

选项:
  --resources <dir>   显式指定 ZCode 的 resources 目录
  --provider <id>     sync 目标供应商（id/名称）；--list 先列出
  --dialect <name>    openai | anthropic | gemini（默认 auto）
  --force-close       安装/还原前强制关闭 ZCode（默认拒绝在运行时写入）
  --force             restore 时覆盖"未知状态"保护
  --no-watch          install 时跳过自动修复触发器
  --no-skill          install 时跳过 skill/command 部署
  --quiet             ensure 静默模式（触发器用）
  --check-only        ensure 只诊断不修复
  --json              status/sync 输出 JSON

示例:
  zcode-model-hub install
  zcode-model-hub sync --list
  zcode-model-hub sync --provider deepseek
  zcode-model-hub status
`;

async function cmdInstall(opts) {
  const { install } = await import("../src/patch/apply.mjs");
  const res = await install({
    resourcesOverride: opts.resources,
    forceClose: opts.forceClose,
    watch: !opts.noWatch,
    deploySkill: !opts.noSkill,
  });
  console.log(`[√] ${res.already ? "注入层已在位（幂等补齐模式）" : "注入完成"} (patch targets: ${Object.keys(res.targets).join(", ")})`);
  if (res.backup) console.log(`    原版备份: ${res.backup}`);
  if (!opts.noSkill) {
    const { deploySkill } = await import("../src/deploy-skill.mjs");
    for (const f of deploySkill()) console.log(`    用户空间已部署: ${f}`);
  }
  if (!opts.noWatch) {
    try {
      const { watch } = await import("../src/repair/triggers.mjs");
      const w = watch({ resourcesOverride: opts.resources });
      console.log(`    自动修复触发器已注册: ${JSON.stringify(w.trigger ?? w)}`);
    } catch (e) {
      console.log(`    [!] 自动修复触发器注册失败（不影响其他层）: ${e.message}`);
    }
  }
  console.log(`    ${res.note}`);
}

async function cmdRestore(opts) {
  const { restore } = await import("../src/patch/apply.mjs");
  const res = await restore({ resourcesOverride: opts.resources, forceClose: opts.forceClose, force: opts.force });
  console.log(`[√] ${res.note}`);
}

async function cmdEnsure(opts) {
  const { findZcodeInstall, isZcodeRunning } = await import("../src/platform.mjs");
  const disc = findZcodeInstall(opts.resources);
  const ctx = {
    asarPath: disc && disc.kind === "app" ? disc.asarPath : "/nonexistent/app.asar",
    isRunning: () => isZcodeRunning(),
    waitStableMs: 1500,
    allowPatch: !opts.checkOnly,
    quiet: opts.quiet,
  };
  const { runEnsure } = await import("../src/repair/ensure.mjs");
  const r = await runEnsure(ctx);
  if (opts.quiet) {
    if (["ok", "repatched", "ok-recovered"].includes(r.action)) process.exit(0);
    if (["deferred-running", "update-in-progress"].includes(r.action)) process.exit(0); // retried later
    process.exit(3); // failed/incompatible/no-app — visible in trigger logs
  }
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else console.log(`[${r.action}]${r.error ? " " + r.error : ""}${r.detail ? " " + JSON.stringify(r.detail) : ""}`);
}

async function cmdSync(opts) {
  mustNode18();
  const { readConfig, listProviders, syncProvider } = await import("../src/config.mjs");
  const { zcodeConfigPath } = await import("../src/platform.mjs");
  const cfgPath = zcodeConfigPath();
  const cfg = readConfig(cfgPath);
  if (!cfg) {
    console.error(`[x] 未找到 ${cfgPath}。请先在 ZCode 里添加自定义供应商。`);
    process.exit(1);
  }
  const providers = listProviders(cfg);
  if (opts.list) {
    if (opts.json) console.log(JSON.stringify(providers.map((p) => ({ id: p.id, kind: p.kind, baseURL: p.baseURL, models: Object.keys(p.models).length })), null, 2));
    else {
      console.log("已配置的自定义供应商:");
      for (const p of providers) {
        console.log(`  [${p.key}] ${p.id}  kind=${p.kind}  baseURL=${p.baseURL || "-"}  models=${Object.keys(p.models).length}`);
      }
      if (!providers.length) console.log("  （空）");
    }
    return;
  }
  if (!providers.length) {
    console.error("[x] 配置中没有任何自定义供应商。");
    process.exit(1);
  }

  let targets;
  if (opts.provider) {
    const want = String(opts.provider).toLowerCase();
    targets = providers.filter((p) => String(p.id).toLowerCase().includes(want) || String(p.name).toLowerCase().includes(want) || String(p.baseURL || "").toLowerCase().includes(want));
    if (!targets.length) {
      console.error(`[x] 找不到匹配 "${opts.provider}" 的供应商。用 sync --list 查看。`);
      process.exit(1);
    }
  } else if (opts.all) {
    targets = providers;
  } else if (process.stdin.isTTY) {
    console.log("选择要同步的供应商:");
    providers.forEach((p, i) => console.log(`  ${i + 1}. ${p.id}  ${p.baseURL || "-"}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((r) => rl.question("编号（多个用逗号分隔，回车=全部）: ", r));
    rl.close();
    const picks = ans.trim() ? ans.split(",").map((s) => parseInt(s.trim(), 10) - 1) : providers.map((_, i) => i);
    targets = picks.map((i) => providers[i]).filter(Boolean);
    if (!targets.length) return console.log("未选择任何供应商。");
  } else {
    console.error("[x] 非交互环境请用 --provider <id> 或 --all。");
    process.exit(1);
  }

  const results = [];
  for (const provider of targets) {
    if (!opts.json) process.stdout.write(`→ ${provider.id} (${provider.baseURL}) ... `);
    let result;
    try {
      result = await syncProvider(cfg, provider, { dialect: opts.dialect, configPath: cfgPath });
    } catch (error) {
      result = { ok: false, error: error.message || String(error) };
    }
    results.push({ provider: provider.id, ...result });
    if (!result.ok) {
      process.exitCode = 1;
      if (!opts.json) {
        console.log("失败");
        console.error(`   ${result.error}`);
      }
    } else if (!opts.json) {
      console.log(`ok: 共 ${result.total} 个模型，新增 ${result.added.length}（方言 ${result.dialect}）`);
    }
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else if (results.some((result) => result.ok))
    console.log("提示: 打开 ZCode 模型选择器即可看到新模型（外部写入实时生效）。");
}

async function cmdStatus(opts) {
  const { inspectInjection } = await import("../src/patch/apply.mjs");
  const { watcherActive } = await import("../src/repair/triggers.mjs");
  const { readPending } = await import("../src/patch/manifest.mjs");
  const { zcodeConfigPath } = await import("../src/platform.mjs");
  const insp = await inspectInjection({ resourcesOverride: opts.resources });
  const lines = [];
  lines.push(`平台: ${platform}   Node: ${process.versions.node}`);
  // layer 1
  let cfgOk = false;
  let providerCount = 0;
  try {
    const { readConfig, listProviders } = await import("../src/config.mjs");
    const cfg = readConfig(zcodeConfigPath());
    cfgOk = !!cfg;
    providerCount = cfg ? listProviders(cfg).length : 0;
  } catch {}
  lines.push(`层1 CLI/技能（更新免疫）: 配置${cfgOk ? "可读" : "不可读/缺失"}，供应商 ${providerCount} 个，命令: sync / 技能 model-hub`);
  // layer 2
  if (!insp.found) lines.push("层2 注入: 未找到 ZCode 安装");
  else if (insp.kind === "appimage") lines.push(`层2 注入: AppImage（不支持注入）`);
  else {
    const m = insp.manifest;
    const state = insp.sentinelPresent ? "在位" : m ? "丢失（ZCode 更新过？运行 ensure 自动修复）" : "未安装";
    lines.push(`层2 注入: ${state}${insp.layoutOk ? "" : `（布局异常: ${insp.layoutError || "?"}）`}${insp.foreign.length ? `；检测到其他补丁: ${insp.foreign.join("、")}` : ""}`);
    if (m) lines.push(`   记录: patchVersion=${m.patchVersion} installed=${m.installedAt}`);
  }
  // layer 3
  const pend = readPending();
  lines.push(`层3 自动修复: 触发器${watcherActive() ? "已注册" : "未注册"}${pend ? `；待处理: ${pend.reason} (${pend.at})` : ""}`);
  console.log(lines.join("\n"));
  if (opts.json) console.log(JSON.stringify({ insp, pending: pend, watcher: watcherActive() }, null, 2));
}

async function cmdDoctor(opts) {
  const findings = [];
  const { findZcodeInstall } = await import("../src/platform.mjs");
  const disc = findZcodeInstall(opts.resources);
  findings.push(["app", disc ? (disc.kind === "appimage" ? "appimage" : "found") : "missing"]);
  if (disc && disc.kind === "app") {
    const { inspectInjection } = await import("../src/patch/apply.mjs");
    const insp = inspectInjection({ resourcesOverride: opts.resources });
    findings.push(["asar", insp.hash ? insp.hash.slice(0, 12) : "unreadable"]);
    findings.push(["layout", insp.layoutOk ? "ok" : `error: ${insp.layoutError}`]);
    findings.push(["sentinel", insp.sentinelPresent ? "present" : "absent"]);
    if (insp.foreign.length) findings.push(["foreign-patches", insp.foreign.join(",")]);
    if (process.platform === "darwin") {
      const integrity = insp.asarIntegrity;
      const description = integrity.status === "enabled"
        ? "error: ENABLED (Electron fuse；注入层不可用)"
        : integrity.status === "unknown"
          ? `error: unknown (${integrity.error})`
          : integrity.status === "disabled" ? "disabled (Electron fuse)" : "not-applicable";
      findings.push(["asar-integrity", description]);
    }
  }
  const { watcherActive } = await import("../src/repair/triggers.mjs");
  findings.push(["watcher", watcherActive() ? "registered" : "not-registered"]);
  const { readPending } = await import("../src/patch/manifest.mjs");
  const pend = readPending();
  findings.push(["pending", pend ? `${pend.reason} @ ${pend.at}` : "none"]);
  try {
    mustNode18();
    findings.push(["node", process.versions.node]);
  } catch {}
  for (const [k, v] of findings) console.log(`${k.padEnd(16)} ${v}`);
  const bad = findings.find(([k, v]) => String(v).startsWith("error") || k === "pending" && v !== "none");
  if (bad && !opts.quiet) {
    const report = { at: new Date().toISOString(), platform: process.platform, findings };
    const { stateDir } = await import("../src/platform.mjs");
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const rp = path.join(dir, "doctor-report.json");
    fs.writeFileSync(rp, JSON.stringify(report, null, 2));
    console.log(`\n[i] 检测到异常，已生成兼容性报告: ${rp}\n    （可携带该文件提交 issue）`);
  }
}

async function cmdWatch(opts) {
  const { watch } = await import("../src/repair/triggers.mjs");
  const r = watch({ resourcesOverride: opts.resources });
  console.log(`[√] 自动修复触发器已注册 (${r.platform}): ${JSON.stringify(r.trigger ?? r)}`);
}

async function cmdUnwatch(opts) {
  const { unwatch } = await import("../src/repair/triggers.mjs");
  const { clearPending } = await import("../src/patch/manifest.mjs");
  const r = unwatch();
  clearPending();
  console.log(`[√] 已卸载触发器 (${r.platform})${r.removed ? ": " + JSON.stringify(r.removed) : ""}`);
}

async function main() {
  const { opts, cmd } = parseArgs(process.argv.slice(2));
  if (opts.version) return console.log(VERSION);
  if (opts.help || !cmd) return console.log(HELP);
  try {
    if (cmd === "install") await cmdInstall(opts);
    else if (cmd === "restore") await cmdRestore(opts);
    else if (cmd === "ensure") await cmdEnsure(opts);
    else if (cmd === "sync") await cmdSync(opts);
    else if (cmd === "status") await cmdStatus(opts);
    else if (cmd === "doctor") await cmdDoctor(opts);
    else if (cmd === "watch") await cmdWatch(opts);
    else if (cmd === "unwatch") await cmdUnwatch(opts);
    else {
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
    }
  } catch (e) {
    let msg = e.message || String(e);
    // macOS Sequoia+ TCC "App Management": writing inside /Applications/*.app
    // is denied for apps without the grant — even as root.
    if (/^(EPERM|EACCES)/.test(msg) && /ZCode\.app|\/Applications\//.test(msg)) {
      msg +=
        "\n[i] 这是 macOS 的「App 管理」保护：写入 /Applications 下的应用内容需要授权。\n" +
        "    系统设置 → 隐私与安全性 → App 管理 → 打开运行本命令的应用\n" +
        "    （ZCode 或你的终端），完全退出并重开该应用后再重试。sudo 无法绕过。";
    }
    console.error(`[x] ${msg}`);
    process.exit(2);
  }
}

main();
