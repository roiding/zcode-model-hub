// Surgical ASAR reader/writer — zero dependencies.
// Format-compatible with @electron/asar. Technique adapted (with attribution)
// from CSSZYF/zcode-modelhub-patch: patched entries are appended after the
// original data region and the header is rewritten, so the original data
// region stays byte-for-byte identical and `app.asar.unpacked` is untouched.
import fs from "node:fs";
import path from "node:path";

export function readHeader(buf) {
  const headerPickleSize = buf.readUInt32LE(4);
  const strLen = buf.readUInt32LE(12);
  const json = buf.slice(16, 16 + strLen).toString("utf8");
  return {
    json: JSON.parse(json),
    dataOffset: 8 + headerPickleSize,
    headerSize: headerPickleSize,
  };
}

export function listFiles(archive) {
  const buf = fs.readFileSync(archive);
  const { json, dataOffset } = readHeader(buf);
  const out = [];
  const walk = (node, rel) => {
    for (const [name, f] of Object.entries(node.files || {})) {
      const p = rel ? `${rel}/${name}` : name;
      if (f.files) walk(f, p);
      else
        out.push({
          rel: p,
          size: f.size,
          offset: f.offset ?? null,
          unpacked: !!f.unpacked,
          integrity: !!f.integrity,
        });
    }
  };
  walk(json, "");
  return { files: out, dataOffset, archiveSize: buf.length };
}

export function readEntry(archive, relPath) {
  const buf = fs.readFileSync(archive);
  const { json, dataOffset } = readHeader(buf);
  let node = json;
  for (const part of relPath.split("/")) {
    node = node.files && node.files[part];
    if (!node) return null;
  }
  if (node.files || node.unpacked) return null;
  const off = dataOffset + parseInt(node.offset, 10);
  return buf.slice(off, off + node.size);
}

export function readEntryText(archive, relPath) {
  const b = readEntry(archive, relPath);
  return b == null ? null : b.toString("utf8");
}

export function hasUnpackedDir(archive) {
  return fs.existsSync(archive + ".unpacked");
}

// Build a minimal asar from a directory. Used for test fixtures and
// synthetic ZCode builds; not used on real installations.
export function packDir(srcDir, outFile, { unpackedSet } = {}) {
  const skip = new Set(unpackedSet || []);
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(srcDir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const full = path.join(srcDir, relPath);
      if (fs.statSync(full).isDirectory()) walk(relPath);
      else files.push({ rel: relPath, size: fs.statSync(full).size, full });
    }
  };
  walk("");
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  let offset = 0;
  const tree = { files: {} };
  const dataFiles = [];
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = tree.files;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { files: {} };
      node = node[parts[i]].files;
    }
    const leafName = parts[parts.length - 1];
    if (skip.has(f.rel)) {
      node[leafName] = { size: f.size, unpacked: true };
    } else {
      node[leafName] = { size: f.size, offset: String(offset) };
      f.offset = offset;
      offset += f.size;
      dataFiles.push(f);
    }
  }

  const headerBuf = buildHeaderBuffer(tree);
  const out = fs.openSync(outFile, "w");
  fs.writeSync(out, headerBuf.prefix);
  fs.writeSync(out, headerBuf.headerPickle);
  const wbuf = Buffer.alloc(1024 * 1024);
  for (const f of dataFiles) {
    const fd = fs.openSync(f.full, "r");
    let read = 0;
    while (read < f.size) {
      const n = fs.readSync(fd, wbuf, 0, Math.min(wbuf.length, f.size - read));
      fs.writeSync(out, wbuf, 0, n);
      read += n;
    }
    fs.closeSync(fd);
  }
  fs.fsyncSync(out);
  fs.closeSync(out);
  if (skip.size) {
    for (const f of files) {
      if (!skip.has(f.rel)) continue;
      const dst = outFile + ".unpacked" + path.sep + f.rel.split("/").join(path.sep);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(f.full, dst);
    }
  }
  return { count: files.length };
}

function buildHeaderBuffer(tree) {
  const jsonBuf = Buffer.from(JSON.stringify(tree), "utf8");
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const payload = Buffer.alloc(4 + jsonBuf.length + pad);
  payload.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(payload, 4);
  const headerPickle = Buffer.alloc(4 + payload.length);
  headerPickle.writeUInt32LE(payload.length, 0);
  payload.copy(headerPickle, 4);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPickle.length, 4);
  return { prefix, headerPickle };
}

// Replace (or create) entries listed in patchMap: { "out/main/index.js": Buffer }.
// The original data region is copied verbatim; patched/new content is appended
// after it. Fails loudly on structural surprises — never writes a broken file.
export function patchEntries(archive, outFile, patchMap, { createMissing = true } = {}) {
  const src = fs.readFileSync(archive);
  const { json, dataOffset } = readHeader(src);
  const tree = JSON.parse(JSON.stringify(json));

  let appendAt = src.length - dataOffset;
  for (const [rel, content] of Object.entries(patchMap)) {
    const parts = rel.split("/");
    let node = tree;
    for (const part of parts) {
      if (!node.files) {
        if (!createMissing) throw new Error(`missing dir for entry: ${rel}`);
        node.files = {};
        node = node.files;
        continue;
      }
      if (!node.files[part]) {
        if (!createMissing) throw new Error(`missing entry: ${rel}`);
        node.files[part] = {};
      }
      node = node.files[part];
    }
    if (node.unpacked)
      throw new Error(`refusing to patch unpacked entry: ${rel}`);
    node.size = content.length;
    delete node.integrity;
    node.offset = String(appendAt);
    appendAt += content.length;
  }

  const headerBuf = buildHeaderBuffer(tree);
  const out = fs.openSync(outFile, "w");
  fs.writeSync(out, headerBuf.prefix);
  fs.writeSync(out, headerBuf.headerPickle);

  // original data region, verbatim
  {
    const CH = 4 * 1024 * 1024;
    const wbuf = Buffer.alloc(CH);
    let remaining = src.length - dataOffset;
    let target = headerBuf.prefix.length + headerBuf.headerPickle.length;
    const fd = fs.openSync(archive, "r");
    let readPos = dataOffset;
    while (remaining > 0) {
      const n = fs.readSync(fd, wbuf, 0, Math.min(CH, remaining), readPos);
      fs.writeSync(out, wbuf, 0, n, target);
      readPos += n;
      target += n;
      remaining -= n;
    }
    fs.closeSync(fd);
  }
  // patched/new entries appended after the data region
  {
    let ap = src.length - dataOffset;
    const base = headerBuf.prefix.length + headerBuf.headerPickle.length;
    for (const [, content] of Object.entries(patchMap)) {
      fs.writeSync(out, content, 0, content.length, base + ap);
      ap += content.length;
    }
  }
  fs.fsyncSync(out);
  fs.closeSync(out);
  return { appended: Object.keys(patchMap).length };
}
