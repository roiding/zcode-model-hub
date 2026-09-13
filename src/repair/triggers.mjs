// Auto-repair triggers. Philosophy: zero resident processes of our own —
// every platform's already-running OS scheduler fires a one-shot
// `ensure --quiet` (fast path = one stat call, exits in milliseconds).
//   macOS  : LaunchAgent (RunAtLoad + WatchPaths on the .app)
//   Windows: Scheduled Task (AtLogOn + 6h repetition) via PowerShell/schtasks
//   Linux  : systemd user .path unit (PathChanged) + oneshot service
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { OS, nodeBinPath, findZcodeInstall } from "../platform.mjs";

const LABEL = "com.zcode-model-hub.repair";

function cliPath() {
  return fs.realpathSync(new URL("../../bin/zcode-model-hub.mjs", import.meta.url));
}

function logDir() {
  const d = path.join(os.homedir(), ".zcode", "model-hub");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- macOS ----------
function launchAgentPlist(asarPath) {
  const appDir = path.dirname(path.dirname(path.dirname(asarPath))); // .../ZCode.app
  const node = nodeBinPath();
  const cli = cliPath();
  const log = path.join(logDir(), "ensure.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>ensure</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key>
  <array>
    <string>${appDir}</string>
    <string>${asarPath}</string>
  </array>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
`;
}

function watchMacOS(install) {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plist = path.join(dir, `${LABEL}.plist`);
  if (install) {
    const disc = findZcodeInstall();
    if (!disc || disc.kind !== "app" || !disc.asarPath)
      throw new Error("macOS 触发器需要已安装的 ZCode.app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plist, launchAgentPlist(disc.asarPath));
    const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { timeout: 10000 });
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { timeout: 10000, encoding: "utf8" });
    if (r.status !== 0 && !/already|bootstrapped/i.test(r.stderr || ""))
      throw new Error(`launchctl bootstrap failed: ${(r.stderr || "").trim()}`);
    return { trigger: plist };
  }
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { timeout: 10000 });
  fs.rmSync(plist, { force: true });
  return { removed: plist };
}

function watcherActiveMacOS() {
  return fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`));
}

// ---------- Windows ----------
function watchWindows(install) {
  const node = nodeBinPath();
  const cli = cliPath();
  const action = `"${node}" "${cli}" ensure --quiet`;
  if (install) {
    const ps = [
      `$action = '${action.replace(/'/g, "''")}'`,
      "$triggers = @()",
      "$triggers += New-ScheduledTaskTrigger -AtLogOn",
      "$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddDays(1)",
      "$t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)).Repetition",
      "$triggers += $t",
      "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable",
      "Register-ScheduledTask -TaskName 'ZCodeModelHubRepair' -Action (New-ScheduledTaskAction -Execute $action) -Trigger $triggers -Settings $s -Force | Out-Null",
      "Write-Output OK",
    ].join("; ");
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 60000 },
    );
    if (r.status !== 0 || !(r.stdout || "").includes("OK")) {
      // fallback: schtasks hourly (no logon trigger, still covers updates)
      const f = spawnSync(
        "schtasks",
        ["/Create", "/F", "/TN", "ZCodeModelHubRepair", "/SC", "HOURLY", "/MO", "1", "/TR", action],
        { encoding: "utf8", timeout: 30000 },
      );
      if (f.status !== 0) throw new Error(`schtasks failed: ${(f.stderr || "").trim()}`);
      return { trigger: "schtasks ZCodeModelHubRepair (hourly fallback)" };
    }
    return { trigger: "Scheduled Task ZCodeModelHubRepair (AtLogOn + 6h)" };
  }
  spawnSync("schtasks", ["/Delete", "/F", "/TN", "ZCodeModelHubRepair"], { timeout: 30000 });
  return { removed: "ZCodeModelHubRepair" };
}

function watcherActiveWindows() {
  const r = spawnSync("schtasks", ["/Query", "/TN", "ZCodeModelHubRepair"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0;
}

// ---------- Linux ----------
function watchLinux(install) {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const service = path.join(unitDir, "zcode-model-hub-repair.service");
  const pathUnit = path.join(unitDir, "zcode-model-hub-repair.path");
  const node = nodeBinPath();
  const cli = cliPath();
  const ctl = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 20000 });

  if (!install) {
    ctl(["disable", "--now", "zcode-model-hub-repair.path"]);
    fs.rmSync(service, { force: true });
    fs.rmSync(pathUnit, { force: true });
    ctl(["daemon-reload"]);
    return { removed: [service, pathUnit] };
  }

  const disc = findZcodeInstall();
  if (!disc || disc.kind !== "app" || !disc.asarPath)
    throw new Error("Linux 触发器需要已安装（非 AppImage）的 ZCode");

  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(
    service,
    `[Unit]
Description=zcode-model-hub auto-repair (one-shot ensure)

[Service]
Type=oneshot
ExecStart=${node} ${cli} ensure --quiet
`,
  );
  fs.writeFileSync(
    pathUnit,
    `[Unit]
Description=zcode-model-hub repair trigger (ZCode files changed)

[Path]
PathChanged=${disc.asarPath}
PathExists=${disc.asarPath}
Unit=zcode-model-hub-repair.service

[Install]
WantedBy=default.target
`,
  );
  ctl(["daemon-reload"]);
  ctl(["disable", "--now", "zcode-model-hub-repair.path"]);
  const r = ctl(["enable", "--now", "zcode-model-hub-repair.path"]);
  if (r.status !== 0)
    throw new Error(`systemctl enable failed: ${(r.stderr || r.stdout || "").trim()}（无 systemd 用户会话？可改用 .desktop 包装器）`);
  return { trigger: [service, pathUnit] };
}

function watcherActiveLinux() {
  const r = spawnSync("systemctl", ["--user", "is-enabled", "zcode-model-hub-repair.path"], {
    encoding: "utf8",
    timeout: 15000,
  });
  return r.status === 0 && (r.stdout || "").trim() === "enabled";
}

// ---------- facade ----------
export function watch({ platform = OS } = {}) {
  if (platform === "darwin") return { platform, ...watchMacOS(true) };
  if (platform === "win32") return { platform, ...watchWindows(true) };
  if (platform === "linux") return { platform, ...watchLinux(true) };
  throw new Error(`unsupported platform: ${platform}`);
}

export function unwatch({ platform = OS } = {}) {
  if (platform === "darwin") return { platform, ...watchMacOS(false) };
  if (platform === "win32") return { platform, ...watchWindows(false) };
  if (platform === "linux") return { platform, ...watchLinux(false) };
  throw new Error(`unsupported platform: ${platform}`);
}

export function watcherActive({ platform = OS } = {}) {
  try {
    if (platform === "darwin") return watcherActiveMacOS();
    if (platform === "win32") return watcherActiveWindows();
    if (platform === "linux") return watcherActiveLinux();
  } catch {}
  return false;
}
