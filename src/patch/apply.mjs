// install / restore orchestration. Every step fails loudly and leaves the
// destination untouched on any surprise: sentinel conflicts, foreign patches,
// missing anchors, running app, asar-integrity fuses, verify mismatches.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PATCH_VERSION,
  SENTINEL,
  ensureBackup,
  backupPathFor,
  pruneBackups,
  loadManifest,
  saveManifest,
  clearPending,
} from "./manifest.mjs";
import { discoverTargets, isAlreadyPatched, detectForeignPatches } from "./discover-targets.mjs";
import { patchEntries, readEntryText, listFiles } from "../archive/surgical-asar.mjs";
import { sha256File, sha256Buf, verifyPatchedArchive, atomicCopyFile } from "../archive/verify.mjs";
import { findZcodeInstall, isZcodeRunning, forceCloseZcode } from "../platform.mjs";

function snippet(name) {
  return fs.readFileSync(new URL(`./snippets/${name}`, import.meta.url), "utf8");
}

function patchHtml(html, scriptRel) {
  if (html.includes(SENTINEL)) throw new Error("renderer html already contains the sentinel");
  const tag = `<script src="./${scriptRel}" defer></script><!-- ${SENTINEL} -->`;
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) throw new Error("renderer html has no </body>");
  return html.slice(0, idx) + "  " + tag + "\n  " + html.slice(idx);
}

// macOS: ElectronAsarIntegrity (if configured) makes any patched asar refuse
// to load. Detect it in Info.plist up front rather than bricking the app.
function checkAsarIntegrityFuse(appBaseDir) {
  if (process.platform !== "darwin") return null;
  const plist = path.join(appBaseDir, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return null;
  try {
    const out = spawnSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "raw", "-o", "-", plist], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (out.status === 0 && (out.stdout || "").trim().length > 0) {
      throw new Error(
        "ZCode 启用了 ElectronAsarIntegrity（app.asar 完整性校验），注入层不可用。CLI/skill 层不受影响。",
      );
    }
  } catch (e) {
    if (String(e.message).startsWith("ZCode 启用了")) throw e;
  }
  return null;
}

export async function install({
  resourcesOverride,
  forceClose = false,
  watch = true,
  deploySkill = true,
  auto = false,
  _isRunning = isZcodeRunning,
  _forceCloseFn = forceCloseZcode,
} = {}) {
  // Bug guard FIRST, before any discovery: auto mode (ensure) MUST be pinned
  // to the resources dir it inspected. Fail fast even on machines without a
  // ZCode installation — discovery would otherwise throw a different error
  // and mask the misuse (CI caught exactly this ordering bug).
  if (auto && !resourcesOverride)
    throw new Error("internal: auto repair requires an explicit resources dir");

  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录，请用 --resources 显式指定 resources 路径");
  if (disc.kind === "appimage")
    throw new Error("AppImage 版本为只读镜像，注入层不支持；CLI/skill 层不受影响");

  const { resourcesDir, asarPath, appBaseDir } = disc;
  checkAsarIntegrityFuse(appBaseDir);

  const targets = discoverTargets(asarPath);
  if (isAlreadyPatched(asarPath, targets))
    throw new Error("检测到本工具已注入（sentinel 存在）。如需重装请先运行 restore。");
  const foreign = detectForeignPatches(asarPath, targets);
  if (foreign.length)
    throw new Error(`检测到其他补丁已注入（${foreign.join("、")}），叠加注入有风险，已停止。请先还原官方版本。`);

  if (_isRunning()) {
    if (auto) throw new Error("deferred: zcode running");
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出 ZCode，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  const originalHash = sha256File(asarPath);
  const backup = ensureBackup(asarPath, originalHash);

  const mainTxt = readEntryText(asarPath, targets.main);
  const preloadTxt = readEntryText(asarPath, targets.preload);
  const htmlTxt = readEntryText(asarPath, targets.rendererHtml);
  if (mainTxt == null || preloadTxt == null || htmlTxt == null)
    throw new Error("目标条目读取失败（可能为 unpacked 条目），ZCode 版本不兼容");

  const patchedMain = Buffer.from(mainTxt + "\n" + snippet("main-handlers.js"), "utf8");
  const patchedPreload = Buffer.from(preloadTxt + "\n" + snippet("preload-bridge.cjs"), "utf8");
  const uiScriptRel = targets.uiScript.split("/").pop();
  const patchedHtml = Buffer.from(patchHtml(htmlTxt, uiScriptRel), "utf8");
  const uiScript = Buffer.from(snippet("ui/zcode-model-hub.js"), "utf8");

  const patchMap = {
    [targets.main]: patchedMain,
    [targets.preload]: patchedPreload,
    [targets.rendererHtml]: patchedHtml,
    [targets.uiScript]: uiScript,
  };
  const expectedHashes = {};
  for (const [rel, buf] of Object.entries(patchMap)) expectedHashes[rel] = sha256Buf(buf);

  const tmpOut = path.join(resourcesDir, "app.asar.model-hub-new");
  patchEntries(asarPath, tmpOut, patchMap);
  const expectedSize = fs.statSync(tmpOut).size;
  verifyPatchedArchive(tmpOut, expectedHashes);

  // replace the live archive atomically
  const liveTmp = asarPath + ".model-hub-tmp";
  fs.rmSync(liveTmp, { force: true });
  fs.copyFileSync(tmpOut, liveTmp);
  if (fs.statSync(liveTmp).size !== expectedSize) {
    fs.rmSync(liveTmp, { force: true });
    throw new Error("live copy size mismatch - aborted, original untouched");
  }
  fs.renameSync(liveTmp, asarPath);
  fs.rmSync(tmpOut, { force: true });

  const patchedHash = sha256File(asarPath);
  const st = fs.statSync(asarPath);
  saveManifest({
    tool: "zcode-model-hub",
    patchVersion: PATCH_VERSION,
    sentinel: SENTINEL,
    platform: process.platform,
    resourcesDir,
    asarPath,
    appBaseDir,
    originalHash,
    patchedHash,
    patchedStat: { size: st.size, mtimeMs: st.mtimeMs },
    targets,
    entryHashes: expectedHashes,
    installedAt: new Date().toISOString(),
  });
  clearPending();
  pruneBackups(2);

  return {
    ok: true,
    backup,
    targets,
    patchedHash,
    note: "重启 ZCode（完全退出后启动）即可看到设置页的「⚡️ 拉取模型」按钮。",
  };
}

export async function restore({
  resourcesOverride,
  forceClose = false,
  force = false,
  auto = false,
  _isRunning = isZcodeRunning,
  _forceCloseFn = forceCloseZcode,
} = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录");
  const { asarPath } = disc;
  const m = loadManifest();
  if (!m || !m.originalHash) throw new Error("没有可用的安装记录（manifest 缺失）");

  const backup = backupPathFor(m.originalHash);
  if (!fs.existsSync(backup)) throw new Error(`找不到原版备份：${backup}`);

  const currentHash = sha256File(asarPath);
  if (currentHash === m.originalHash) return { ok: true, note: "当前已是官方原版，无需还原。" };
  if (currentHash !== m.patchedHash && !force)
    throw new Error("当前 app.asar 既不是已注入版本也不是记录中的原版（ZCode 更新过？）。用 --force 覆盖为旧版原版，或先确认。");

  if (_isRunning()) {
    if (auto) throw new Error("deferred: zcode running");
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  atomicCopyFile(backup, asarPath, { expectSize: fs.statSync(backup).size });
  // keep the manifest (patched state is gone; originalHash stays useful)
  const st = fs.statSync(asarPath);
  m.restoredAt = new Date().toISOString();
  m.patchedStat = { size: st.size, mtimeMs: st.mtimeMs };
  saveManifest(m);
  clearPending();
  return { ok: true, note: "已还原官方原版 app.asar。重启 ZCode 生效。" };
}

// read-only status for status/doctor
export function inspectInjection({ resourcesOverride } = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) return { found: false };
  if (disc.kind === "appimage") return { found: true, kind: "appimage", note: "AppImage 只读镜像，注入层不支持" };
  const { asarPath, appBaseDir } = disc;
  const m = loadManifest();
  const out = { found: true, asarPath, manifest: m, hash: null, sentinelPresent: false, layoutOk: false, targets: null, foreign: [] };
  try {
    const targets = discoverTargets(asarPath);
    out.targets = targets;
    out.layoutOk = true;
    out.sentinelPresent = isAlreadyPatched(asarPath, targets);
    out.foreign = detectForeignPatches(asarPath, targets);
  } catch (e) {
    out.layoutError = e.message;
  }
  try {
    out.hash = sha256File(asarPath);
  } catch {}
  return out;
}
