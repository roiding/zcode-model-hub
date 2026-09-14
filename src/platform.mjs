// Cross-platform ZCode discovery, process checks and (manual-only) process
// close. Auto-repair never uses forceClose — it defers instead.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const OS = process.platform; // darwin | win32 | linux

export function home() {
  return os.homedir();
}

export function stateDir() {
  if (process.env.ZCODE_MODEL_HUB_STATE_DIR) return process.env.ZCODE_MODEL_HUB_STATE_DIR;
  return path.join(home(), ".zcode", "model-hub");
}

export function zcodeConfigPath() {
  return path.join(home(), ".zcode", "v2", "config.json");
}

export function appBaseCandidates() {
  if (OS === "darwin") {
    return [
      "/Applications/ZCode.app",
      path.join(home(), "Applications", "ZCode.app"),
    ];
  }
  if (OS === "win32") {
    const cands = [];
    const lad = process.env.LOCALAPPDATA;
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"];
    if (lad) cands.push(path.join(lad, "Programs", "ZCode"));
    cands.push(path.join(pf, "ZCode"));
    if (pf86) cands.push(path.join(pf86, "ZCode"));
    // Best-effort registry lookup (per-user uninstall entries included).
    try {
      for (const hive of ["HKCU", "HKLM"]) {
        const out = spawnSync(
          "reg",
          [
            "query",
            `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
            "/s",
            "/f",
            "ZCode",
            "/d",
          ],
          { encoding: "utf8", timeout: 20000 },
        );
        if (out.status === 0 && out.stdout) {
          for (const m of out.stdout.matchAll(/InstallLocation\s+REG_SZ\s+(.*)/g)) {
            const loc = m[1].trim();
            if (loc) cands.push(loc);
          }
        }
      }
    } catch {}
    return cands;
  }
  // linux
  return [
    "/opt/ZCode",
    "/usr/share/zcode",
    "/usr/lib/zcode",
    path.join(home(), ".local", "share", "ZCode"),
    path.join(home(), "Applications", "ZCode"),
  ];
}

export function appBaseDirFor(resourcesDir, platform = OS) {
  const parent = path.dirname(resourcesDir);
  return platform === "darwin" && path.basename(parent) === "Contents" ? path.dirname(parent) : parent;
}

// Returns { resourcesDir, asarPath, appBaseDir, kind: "app"|"appimage" } or null.
export function findZcodeInstall(explicitResources) {
  if (explicitResources) {
    const resourcesDir = path.resolve(explicitResources);
    const asarPath = path.join(resourcesDir, "app.asar");
    if (!fs.existsSync(asarPath)) throw new Error(`no app.asar under ${explicitResources}`);
    return { resourcesDir, asarPath, appBaseDir: appBaseDirFor(resourcesDir), kind: "app" };
  }

  // AppImage: read-only squashfs mount — patch layer is unsupported there.
  if (OS === "linux" && process.env.APPIMAGE && /zcode/i.test(process.env.APPIMAGE)) {
    return { kind: "appimage", appimage: process.env.APPIMAGE };
  }

  const candidates = [];
  for (const base of appBaseCandidates()) {
    if (OS === "darwin") candidates.push(path.join(base, "Contents", "Resources"));
    else candidates.push(path.join(base, "resources"));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "app.asar"))) {
      return {
        resourcesDir: c,
        asarPath: path.join(c, "app.asar"),
        appBaseDir: appBaseDirFor(c),
        kind: "app",
      };
    }
  }
  return null;
}

export function isZcodeRunning() {
  try {
    if (OS === "win32") {
      const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe"], {
        encoding: "utf8",
        timeout: 15000,
      });
      return out.status === 0 && (out.stdout || "").includes("ZCode.exe");
    }
    const name = OS === "darwin" ? "ZCode" : "zcode";
    let out = spawnSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 10000 });
    if (out.status === 0 && (out.stdout || "").trim()) return true;
    if (OS === "darwin") {
      // Electron helper processes can carry a different name; path match as fallback.
      out = spawnSync("pgrep", ["-f", "ZCode.app/Contents/MacOS"], { encoding: "utf8", timeout: 10000 });
      if (out.status === 0 && (out.stdout || "").trim()) return true;
    }
    return false;
  } catch {
    return false; // assume not running only when probing itself failed
  }
}

// Manual install/restore only. Auto-repair MUST NOT call this.
export function forceCloseZcode() {
  if (OS === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "ZCode" to quit'], { timeout: 10000 });
  }
  const name = OS === "win32" ? "ZCode.exe" : OS === "darwin" ? "ZCode" : "zcode";
  for (let i = 0; i < 10; i++) {
    if (!isZcodeRunning()) return true;
    try {
      if (OS === "win32") spawnSync("taskkill", ["/IM", name, "/F"], { timeout: 10000 });
      else spawnSync("pkill", ["-x", name], { timeout: 10000 });
    } catch {}
    const until = Date.now() + 800;
    while (Date.now() < until) {}
  }
  return !isZcodeRunning();
}

export function nodeBinPath() {
  return process.execPath;
}
