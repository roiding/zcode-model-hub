// Manifest + backup state, all under ~/.zcode/model-hub/.
// - manifest.json: what we patched and how to recognize it (fast path stats).
// - backups/<originalHash>/app.asar: cold copy of the official archive,
//   keyed by the official build's hash, pruned to the last 2 versions.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../platform.mjs";
import { atomicWriteBuffer, atomicCopyFile, sha256File } from "../archive/verify.mjs";

export const PATCH_VERSION = "1.0.0";
export const SENTINEL = "__ZCODE_MODEL_HUB_V1__";

export function manifestPath(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "manifest.json");
}

export function backupsDir(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "backups");
}

export function pendingPath(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "pending.json");
}

export function loadManifest(stateDirOverride) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(stateDirOverride), "utf8"));
  } catch {
    return null;
  }
}

export function saveManifest(m, stateDirOverride) {
  const dir = stateDirOverride || stateDir();
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteBuffer(
    manifestPath(stateDirOverride),
    Buffer.from(JSON.stringify(m, null, 2), "utf8"),
  );
}

export function clearManifest(stateDirOverride) {
  try {
    fs.rmSync(manifestPath(stateDirOverride), { force: true });
  } catch {}
}

export function writePending(p, stateDirOverride) {
  const dir = stateDirOverride || stateDir();
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteBuffer(
    pendingPath(stateDirOverride),
    Buffer.from(JSON.stringify({ ...p, at: new Date().toISOString() }, null, 2), "utf8"),
  );
}

export function readPending(stateDirOverride) {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(stateDirOverride), "utf8"));
  } catch {
    return null;
  }
}

export function clearPending(stateDirOverride) {
  try {
    fs.rmSync(pendingPath(stateDirOverride), { force: true });
  } catch {}
}

// One cold backup per official archive hash. Never overwritten once present.
export function ensureBackup(asarPath, originalHash, stateDirOverride) {
  const dir = path.join(backupsDir(stateDirOverride), originalHash);
  const dst = path.join(dir, "app.asar");
  if (fs.existsSync(dst)) {
    if (sha256File(dst) === originalHash) return dst;
    // corrupted backup: rebuild it
    fs.rmSync(dst, { force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  atomicCopyFile(asarPath, dst, { expectSize: fs.statSync(asarPath).size });
  return dst;
}

export function backupPathFor(originalHash, stateDirOverride) {
  return path.join(backupsDir(stateDirOverride), originalHash, "app.asar");
}

export function pruneBackups(keep = 2, stateDirOverride) {
  const dir = backupsDir(stateDirOverride);
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = path.join(dir, d.name);
      return { dir: p, hash: d.name, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const e of entries.slice(keep)) {
    fs.rmSync(e.dir, { recursive: true, force: true });
    removed.push(e.hash);
  }
  return removed;
}

export function listBackups(stateDirOverride) {
  const dir = backupsDir(stateDirOverride);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ hash: d.name, mtime: fs.statSync(path.join(dir, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}
