#!/usr/bin/env bash
# zcode-model-hub uninstaller (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[i] 卸载: 还原 app.asar + 卸载触发器 + 移除 skill/command"
node bin/zcode-model-hub.mjs unwatch || true
node bin/zcode-model-hub.mjs restore "$@"
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
for (const t of [path.join(os.homedir(), ".zcode", "skills", "model-hub"), path.join(os.homedir(), ".zcode", "commands", "pull-models.md")]) {
  fs.rmSync(t, { recursive: true, force: true });
  console.log("removed:", t);
}
'
echo "[√] 完成。配置文件 ~/.zcode/v2/config.json 未改动（如需清理供应商请手动编辑）。"
