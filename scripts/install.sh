#!/usr/bin/env bash
# zcode-model-hub one-shot installer (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 未找到 node。请先安装 Node.js >= 18: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[x] Node.js >= 18 必需（当前 $(node -v)）" >&2
  exit 1
fi

echo "[i] 安装 zcode-model-hub（注入 + 用户空间技能 + 自动修复触发器）"
exec node bin/zcode-model-hub.mjs install "$@"
