# Install Service Runner: dependencies, tray icon, Windows logon startup, then start it.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm install
} else {
  npm install
}

node scripts/make-icon.mjs
npx --yes tsx src/index.ts --setup
