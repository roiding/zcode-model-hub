// `ensure` — the auto-repair state machine. Designed as a one-shot process:
// fast path is a single stat() (microseconds); hashing happens only when
// stats drift; patching only when ZCode actually updated AND is not running.
// All dependencies are injectable for tests.
import fs from "node:fs";
import path from "node:path";
import {
  loadManifest,
  saveManifest,
  writePending,
  readPending,
  clearPending,
} from "../patch/manifest.mjs";
import { sha256File } from "../archive/verify.mjs";
import { discoverTargets, isAlreadyPatched } from "../patch/discover-targets.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statSnapshot(st) {
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function sameStat(a, st) {
  return a && a.size === st.size && a.mtimeMs === st.mtimeMs;
}

// ctx: { asarPath, isRunning(), waitStableMs, allowPatch, quiet, now() }
export async function runEnsure(ctx) {
  const { asarPath, isRunning = () => false, waitStableMs = 1500, allowPatch = true } = ctx;
  const result = { action: "unknown" };

  if (!fs.existsSync(asarPath)) {
    result.action = "no-app";
    return result;
  }
  const m = loadManifest();
  let st;
  try {
    st = fs.statSync(asarPath);
  } catch {
    result.action = "stat-failed";
    return result;
  }

  // Fast path: size+mtime still match the recorded patched state.
  if (m && m.patchedStat && sameStat(m.patchedStat, st)) {
    result.action = "ok";
    clearPending();
    return result;
  }

  // Hash once to distinguish mtime drift from a real change.
  let h1;
  try {
    h1 = sha256File(asarPath);
  } catch (e) {
    result.action = "hash-failed";
    result.error = e.message;
    return result;
  }
  if (m && m.patchedHash === h1) {
    m.patchedStat = statSnapshot(st);
    saveManifest(m);
    result.action = "ok";
    clearPending();
    return result;
  }

  // Hash changed: debounce — if it changes again quickly, an update is
  // still in progress; leave it alone and mark pending.
  await sleep(waitStableMs);
  let h2;
  try {
    h2 = sha256File(asarPath);
  } catch {
    result.action = "update-in-progress";
    writePending({ reason: "update-in-progress", asarPath });
    return result;
  }
  if (h2 !== h1) {
    result.action = "update-in-progress";
    writePending({ reason: "update-in-progress", asarPath });
    return result;
  }

  // Stable new archive. If ZCode is running, never touch it — defer.
  if (isRunning()) {
    result.action = "deferred-running";
    writePending({ reason: "zcode-running", asarPath, hash: h2 });
    return result;
  }

  // Classify the new archive: already ours? layout intact?
  let targets = null;
  let ours = false;
  try {
    targets = discoverTargets(asarPath);
    ours = isAlreadyPatched(asarPath, targets);
  } catch (e) {
    result.action = "incompatible";
    result.error = e.message;
    writePending({ reason: "incompatible", asarPath, hash: h2, error: e.message });
    return result;
  }

  if (ours) {
    // our own patch (e.g. manifest cache was stale) — just re-record state
    const updated = { ...(m || { tool: "zcode-model-hub" }), patchedHash: h2, patchedStat: statSnapshot(fs.statSync(asarPath)), targets };
    saveManifest(updated);
    result.action = "ok";
    clearPending();
    return result;
  }

  if (!allowPatch) {
    result.action = "needs-patch";
    return result;
  }

  // Real update of an unpatched archive -> adaptive reinstall.
  // IMPORTANT: pin install() to the exact resources dir we just inspected —
  // without this, auto mode could re-discover (and patch) a different
  // installation on the machine.
  try {
    const { install } = await import("../patch/apply.mjs");
    const res = await install({
      auto: true,
      _isRunning: isRunning,
      resourcesOverride: path.dirname(asarPath),
    });
    result.action = res.ok ? "repatched" : "failed";
    result.detail = res;
  } catch (e) {
    result.action = "failed";
    result.error = e.message;
    writePending({ reason: "install-failed", asarPath, hash: h2, error: e.message });
  }
  return result;
}

export function pendingSummary() {
  const p = readPending();
  return p || null;
}
