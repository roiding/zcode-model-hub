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
function xmlText(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}

export function launchAgentPlist(asarPath, { node = nodeBinPath(), cli = cliPath(), log = path.join(logDir(), "ensure.log") } = {}) {
  const appDir = path.dirname(path.dirname(path.dirname(asarPath))); // .../ZCode.app
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(node)}</string>
    <string>${xmlText(cli)}</string>
    <string>ensure</string>
    <string>--quiet</string>
    <string>--resources</string>
    <string>${xmlText(path.dirname(asarPath))}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key>
  <array>
    <string>${xmlText(appDir)}</string>
    <string>${xmlText(asarPath)}</string>
  </array>
  <key>StandardOutPath</key><string>${xmlText(log)}</string>
  <key>StandardErrorPath</key><string>${xmlText(log)}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
`;
}

function watchMacOS(install, resourcesOverride) {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plist = path.join(dir, `${LABEL}.plist`);
  if (install) {
    const disc = findZcodeInstall(resourcesOverride);
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
function quoteWindowsArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, (match, slashes) => slashes.repeat(2) + '\\"').replace(/(\\+)$/, "$1$1") + '"';
}

export function windowsTaskAction(node, cli, resourcesDir) {
  const parameters = [cli, "ensure", "--quiet"];
  if (resourcesDir) parameters.push("--resources", resourcesDir);
  const argumentsLine = parameters.map(quoteWindowsArgument).join(" ");
  return { execute: node, arguments: argumentsLine, command: quoteWindowsArgument(node) + " " + argumentsLine };
}

export function windowsTaskScript(action) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute '${action.execute.replace(/'/g, "''")}' -Argument '${action.arguments.replace(/'/g, "''")}'`,
    "$triggers = @()",
    "$triggers += New-ScheduledTaskTrigger -AtLogOn",
    "$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddDays(1)",
    "$repeatTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)).Repetition",
    "$triggers += $repeatTrigger",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable",
    "Register-ScheduledTask -TaskName 'ZCodeModelHubRepair' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null",
    "Write-Output OK",
  ].join("; ");
}

function watchWindows(install, resourcesOverride) {
  const node = nodeBinPath();
  const cli = cliPath();
  const resourcesDir = install ? findZcodeInstall(resourcesOverride)?.resourcesDir : undefined;
  const action = windowsTaskAction(node, cli, resourcesDir);
  if (install) {
    const ps = windowsTaskScript(action);
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 60000 },
    );
    if (r.status !== 0 || !(r.stdout || "").includes("OK")) {
      // fallback: schtasks hourly (no logon trigger, still covers updates)
      const f = spawnSync(
        "schtasks",
        ["/Create", "/F", "/TN", "ZCodeModelHubRepair", "/SC", "HOURLY", "/MO", "1", "/TR", action.command],
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
function quoteSystemdArgument(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, () => "$$").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
}

export function linuxUnitContents(asarPath, { node = nodeBinPath(), cli = cliPath() } = {}) {
  if (/[\r\n]/.test(asarPath)) throw new Error("unsupported line break in asar path");
  const command = [node, cli, "ensure", "--quiet", "--resources", path.dirname(asarPath)].map(quoteSystemdArgument).join(" ");
  return {
    service: `[Unit]
Description=zcode-model-hub auto-repair (one-shot ensure)

[Service]
Type=oneshot
ExecStart=${command}

[Install]
WantedBy=default.target
`,
    pathUnit: `[Unit]
Description=zcode-model-hub repair trigger (ZCode files changed)

[Path]
PathChanged=${asarPath.replace(/%/g, "%%")}
Unit=zcode-model-hub-repair.service

[Install]
WantedBy=default.target
`,
  };
}

function watchLinux(install, resourcesOverride) {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const service = path.join(unitDir, "zcode-model-hub-repair.service");
  const pathUnit = path.join(unitDir, "zcode-model-hub-repair.path");
  const node = nodeBinPath();
  const cli = cliPath();
  const ctl = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 20000 });

  if (!install) {
    ctl(["disable", "--now", "zcode-model-hub-repair.path", "zcode-model-hub-repair.service"]);
    fs.rmSync(service, { force: true });
    fs.rmSync(pathUnit, { force: true });
    ctl(["daemon-reload"]);
    return { removed: [service, pathUnit] };
  }

  const disc = findZcodeInstall(resourcesOverride);
  if (!disc || disc.kind !== "app" || !disc.asarPath)
    throw new Error("Linux 触发器需要已安装（非 AppImage）的 ZCode");

  fs.mkdirSync(unitDir, { recursive: true });
  const contents = linuxUnitContents(disc.asarPath, { node, cli });
  fs.writeFileSync(service, contents.service);
  fs.writeFileSync(pathUnit, contents.pathUnit);
  ctl(["daemon-reload"]);
  ctl(["disable", "--now", "zcode-model-hub-repair.path"]);
  const r = ctl(["enable", "--now", "zcode-model-hub-repair.path", "zcode-model-hub-repair.service"]);
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
export function watch({ platform = OS, resourcesOverride } = {}) {
  if (platform === "darwin") return { platform, ...watchMacOS(true, resourcesOverride) };
  if (platform === "win32") return { platform, ...watchWindows(true, resourcesOverride) };
  if (platform === "linux") return { platform, ...watchLinux(true, resourcesOverride) };
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
