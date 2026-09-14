// install / restore orchestration. Every step fails loudly and leaves the
// destination untouched on any surprise: sentinel conflicts, foreign patches,
// missing anchors, running app, asar-integrity fuses, verify mismatches.
import fs from "node:fs";
import path from "node:path";
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
import { inspectAsarIntegrity } from "./asar-integrity.mjs";

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

function checkAsarIntegrityFuse(appBaseDir) {
  const integrity = inspectAsarIntegrity(appBaseDir);
  if (integrity.status === "enabled")
    throw new Error("ZCode 的 EnableEmbeddedAsarIntegrityValidation fuse 已启用（app.asar 完整性校验），注入层不可用。CLI/skill 层不受影响。");
  if (integrity.status === "unknown")
    throw new Error(`无法确认 Electron ASAR 完整性校验开关，已停止注入，未修改应用：${integrity.error}`);
  return integrity;
}

// Build the desired patched entry contents from an UNPATCHED source archive
// (the live asar on first install, or the cold backup when upgrading).
function buildPatchedEntries(sourceAsar, targets) {
  const mainTxt = readEntryText(sourceAsar, targets.main);
  const preloadTxt = readEntryText(sourceAsar, targets.preload);
  const htmlTxt = readEntryText(sourceAsar, targets.rendererHtml);
  if (mainTxt == null || preloadTxt == null || htmlTxt == null)
    throw new Error("目标条目读取失败（可能为 unpacked 条目），ZCode 版本不兼容");

  const uiScriptRel = targets.uiScript.split("/").pop();
  const patchMap = {
    [targets.main]: Buffer.from(mainTxt + "\n" + snippet("main-handlers.js"), "utf8"),
    [targets.preload]: Buffer.from(preloadTxt + "\n" + snippet("preload-bridge.cjs"), "utf8"),
    [targets.rendererHtml]: Buffer.from(patchHtml(htmlTxt, uiScriptRel), "utf8"),
    [targets.uiScript]: Buffer.from(snippet("ui/zcode-model-hub.js"), "utf8"),
  };
  const entryHashes = {};
  for (const [rel, buf] of Object.entries(patchMap)) entryHashes[rel] = sha256Buf(buf);
  return { patchMap, entryHashes };
}

// Surgical repack from sourceAsar + atomic replace of the live archive.
function writePatchedArchive(resourcesDir, asarPath, sourceAsar, targets, desired, manifestBase) {
  const tmpOut = path.join(resourcesDir, "app.asar.model-hub-new");
  patchEntries(sourceAsar, tmpOut, desired.patchMap);
  const expectedSize = fs.statSync(tmpOut).size;
  verifyPatchedArchive(tmpOut, desired.entryHashes);

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
    ...manifestBase,
    tool: "zcode-model-hub",
    patchVersion: PATCH_VERSION,
    sentinel: SENTINEL,
    platform: process.platform,
    resourcesDir,
    asarPath,
    targets,
    entryHashes: desired.entryHashes,
    patchedHash,
    patchedStat: { size: st.size, mtimeMs: st.mtimeMs },
    updatedAt: new Date().toISOString(),
  });
  clearPending();
  pruneBackups(2);
  return patchedHash;
}

function requireNotRunning(_isRunning, forceClose, _forceCloseFn, { auto }) {
  if (!_isRunning()) return;
  if (auto) throw new Error("deferred: zcode running");
  if (!forceClose) throw new Error("ZCode 正在运行。请先退出 ZCode，或使用 --force-close。");
  if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
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
  const m0 = loadManifest();
  const curHash = sha256File(asarPath);

  // Already ours? Either upgrade the injected content from the cold backup
  // (snippets changed since the last install) or just resume the remaining
  // layers — never hard-fail on a half-finished setup.
  if (isAlreadyPatched(asarPath, targets)) {
    const backupAsar = m0 && m0.originalHash ? backupPathFor(m0.originalHash) : null;
    const canRebuild =
      backupAsar && fs.existsSync(backupAsar) && m0.patchedHash === curHash;

    if (canRebuild) {
      if (sha256File(backupAsar) !== m0.originalHash)
        throw new Error("原版备份哈希不匹配，已停止升级，当前 app.asar 未改动");
      const desired = buildPatchedEntries(backupAsar, targets);
      const unchanged =
        m0.entryHashes &&
        Object.entries(desired.entryHashes).every(([k, v]) => m0.entryHashes[k] === v);
      if (!unchanged) {
        requireNotRunning(_isRunning, forceClose, _forceCloseFn, { auto });
        writePatchedArchive(resourcesDir, asarPath, backupAsar, targets, desired, m0);
        return {
          ok: true,
          updated: true,
          targets,
          note: "注入内容已从原版备份重建（升级）。完全退出并重启 ZCode 生效。",
        };
      }
    }

    // resume-only: nothing to repatch, complete the remaining layers
    if (!m0 || m0.patchedHash !== curHash) {
      const st = fs.statSync(asarPath);
      saveManifest({
        ...(m0 || {}),
        tool: "zcode-model-hub",
        patchVersion: PATCH_VERSION,
        sentinel: SENTINEL,
        platform: process.platform,
        resourcesDir,
        asarPath,
        appBaseDir,
        targets,
        patchedHash: curHash,
        patchedStat: { size: st.size, mtimeMs: st.mtimeMs },
        updatedAt: new Date().toISOString(),
      });
      clearPending();
    }
    return {
      ok: true,
      already: true,
      targets,
      note: "注入层已在位，本次仅补齐用户空间技能与触发器。",
    };
  }

  const foreign = detectForeignPatches(asarPath, targets);
  if (foreign.length)
    throw new Error(`检测到其他补丁已注入（${foreign.join("、")}），叠加注入有风险，已停止。请先还原官方版本。`);

  requireNotRunning(_isRunning, forceClose, _forceCloseFn, { auto });

  const originalHash = sha256File(asarPath);
  const backup = ensureBackup(asarPath, originalHash);

  const desired = buildPatchedEntries(asarPath, targets);
  const patchedHash = writePatchedArchive(resourcesDir, asarPath, asarPath, targets, desired, {
    originalHash,
    appBaseDir,
    installedAt: new Date().toISOString(),
  });

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
  if (sha256File(backup) !== m.originalHash)
    throw new Error("原版备份哈希不匹配，已停止还原，当前 app.asar 未改动");

  const currentHash = sha256File(asarPath);
  if (currentHash === m.originalHash) return { ok: true, note: "当前已是官方原版，无需还原。" };
  if (currentHash !== m.patchedHash && !force)
    throw new Error("当前 app.asar 既不是已注入版本也不是记录中的原版（ZCode 更新过？）。用 --force 覆盖为旧版原版，或先确认。");

  if (_isRunning()) {
    if (auto) throw new Error("deferred: zcode running");
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  atomicCopyFile(backup, asarPath, { expectSize: fs.statSync(backup).size, expectHash: m.originalHash });
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
  out.asarIntegrity = inspectAsarIntegrity(appBaseDir);
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
