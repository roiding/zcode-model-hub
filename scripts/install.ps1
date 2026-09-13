# zcode-model-hub installer for Windows (PowerShell)
# usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-ForceClose]
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host "[x] Node.js >= 18 required: https://nodejs.org" -ForegroundColor Red; exit 1 }
$major = [int]($node.Version.Split(".")[0])
if ($major -lt 18) { Write-Host "[x] Node.js >= 18 required (current $($node.Version))" -ForegroundColor Red; exit 1 }

Write-Host "[i] installing zcode-model-hub (patch + user-space skill + auto-repair trigger)"
if ($ForceClose) { node bin/zcode-model-hub.mjs install --force-close }
else { node bin/zcode-model-hub.mjs install }
