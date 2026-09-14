// Verification + atomic-write primitives. Every write in this tool goes
// through here: temp file in the same directory -> fsync -> size/hash check
// -> atomic rename. On any mismatch the destination is left untouched.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readHeader, listFiles, readEntry } from "./surgical-asar.mjs";

export function sha256Buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    while (true) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      h.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// Write buffer to dest atomically. expectSize (if given) is verified on the
// temp file before rename.
export function atomicWriteBuffer(dest, buf, { expectSize = buf.length, mode, beforeRename } = {}) {
  const temporary = `${dest}.model-hub-${crypto.randomUUID()}.tmp`;
  const permissions = mode ?? (fs.existsSync(dest) ? fs.statSync(dest).mode & 0o777 : 0o666);
  try {
    const descriptor = fs.openSync(temporary, "wx", permissions);
    try {
      fs.writeFileSync(descriptor, buf);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const actualSize = fs.statSync(temporary).size;
    if (actualSize !== expectSize)
      failClean(temporary, `size mismatch on temp file: got ${actualSize}, expected ${expectSize}`);
    if (beforeRename) beforeRename();
    fs.renameSync(temporary, dest);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Copy src -> dest atomically (used for backups/restores).
export function atomicCopyFile(src, dest, { expectSize, expectHash, mode } = {}) {
  const temporary = `${dest}.model-hub-${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(src, temporary, fs.constants.COPYFILE_EXCL);
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    const copiedStat = fs.statSync(temporary);
    const actualSize = copiedStat.size;
    if (expectSize !== undefined && actualSize !== expectSize)
      failClean(temporary, `size mismatch on temp copy: got ${actualSize}, expected ${expectSize}`);
    if (expectHash !== undefined && sha256File(temporary) !== expectHash)
      failClean(temporary, "hash mismatch on temp copy");
    const copiedMode = copiedStat.mode & 0o777;
    if (!(copiedMode & 0o200)) fs.chmodSync(temporary, copiedMode | 0o200);
    const descriptor = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!(copiedMode & 0o200)) fs.chmodSync(temporary, copiedMode);
    fs.renameSync(temporary, dest);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function failClean(tmp, msg) {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}
  throw new Error(`[verify] ${msg} - aborted, destination untouched`);
}

// After a surgical repack, prove the result is a healthy asar and that every
// patched entry matches the exact bytes we intended to write.
export function verifyPatchedArchive(archive, expectedEntries) {
  let header;
  try {
    header = peekHeader(archive);
  } catch (e) {
    throw new Error(`[verify] patched archive header unreadable: ${e.message}`);
  }
  if (!header.json || !header.json.files)
    throw new Error("[verify] patched archive header has no file tree");

  for (const [rel, expectedHash] of Object.entries(expectedEntries)) {
    const entry = readEntry(archive, rel);
    if (!entry) throw new Error(`[verify] patched entry missing: ${rel}`);
    const got = sha256Buf(entry);
    if (got !== expectedHash)
      throw new Error(`[verify] entry ${rel} hash mismatch after repack`);
  }
  return true;
}

// Parse the header without loading the whole payload into one big slice.
export function peekHeader(archive) {
  const fd = fs.openSync(archive, "r");
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const strLen = sizeBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(strLen);
    fs.readSync(fd, jsonBuf, 0, strLen, 16);
    return { json: JSON.parse(jsonBuf.toString("utf8")) };
  } finally {
    fs.closeSync(fd);
  }
}

export { readHeader, listFiles, readEntry };
