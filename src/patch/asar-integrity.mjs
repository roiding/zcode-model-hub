import fs from "node:fs";
import path from "node:path";

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const CHUNK_SIZE = 4 * 1024 * 1024;
const INTEGRITY_FUSE_INDEX = 4;

function readAt(descriptor, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    const received = fs.readSync(descriptor, buffer, total, buffer.length - total, position + total);
    if (received === 0) throw new Error("Electron fuse 数据不完整，二进制文件可能已变化");
    total += received;
  }
  return buffer;
}

export function readAsarIntegrityFuses(binaryPath) {
  const descriptor = fs.openSync(binaryPath, "r");
  try {
    const initialStat = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(CHUNK_SIZE + SENTINEL.length - 1);
    const wires = [];
    for (let position = 0; position < initialStat.size; position += CHUNK_SIZE) {
      const chunk = readAt(descriptor, buffer.subarray(0, Math.min(buffer.length, initialStat.size - position)), position);
      for (let offset = chunk.indexOf(SENTINEL); offset >= 0 && offset < CHUNK_SIZE; offset = chunk.indexOf(SENTINEL, offset + SENTINEL.length)) {
        const wirePosition = position + offset + SENTINEL.length;
        const header = readAt(descriptor, Buffer.alloc(2), wirePosition);
        const version = header[0];
        const count = header[1];
        if (version !== 1) throw new Error(`不支持的 Electron fuse wire 版本：${version}`);
        if (count <= INTEGRITY_FUSE_INDEX) throw new Error("Electron fuse wire 不包含 ASAR 校验开关");
        const states = readAt(descriptor, Buffer.alloc(count), wirePosition + 2);
        const state = states[INTEGRITY_FUSE_INDEX];
        if (state !== 0x30 && state !== 0x31) throw new Error(`无法识别 ASAR 校验 fuse 状态：${state}`);
        wires.push({ offset: position + offset, version, count, enabled: state === 0x31 });
        if (wires.length > 2) throw new Error("Electron 二进制包含超过两个 fuse wire，无法安全确认架构状态");
      }
    }
    if (!wires.length) throw new Error("Electron Framework 中未找到 fuse wire");
    const finalStat = fs.fstatSync(descriptor);
    if (finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs)
      throw new Error("Electron 二进制在检查期间发生变化，请稍后重试");
    return wires;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function inspectAsarIntegrity(appBaseDir, { platform = process.platform } = {}) {
  if (platform !== "darwin") return { status: "not-applicable" };
  const binaryPath = path.join(appBaseDir, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  const plistPath = path.join(appBaseDir, "Contents", "Info.plist");
  if (!fs.existsSync(binaryPath) && !fs.existsSync(plistPath) && !appBaseDir.endsWith(".app"))
    return { status: "not-applicable" };
  try {
    const wires = readAsarIntegrityFuses(binaryPath);
    return { status: wires.some((wire) => wire.enabled) ? "enabled" : "disabled", binaryPath, wires };
  } catch (error) {
    return { status: "unknown", binaryPath, error: error.message || String(error) };
  }
}
