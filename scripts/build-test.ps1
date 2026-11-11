# Builds a release exe (no installer) and copies it to .\test as the next numbered test build
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\env.ps1"
Set-Location $root
if (-not (Test-Path node_modules)) { npm install }
npm run tauri -- build --no-bundle
New-Item -ItemType Directory -Force test | Out-Null
# Every build gets the next number (test1, test2, ...) so earlier test builds are never overwritten.
$prefix = 'sailhighsea-vm-v0.0.1-test'
$last = Get-ChildItem test -Filter "$prefix*.exe" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.BaseName -match "^$([regex]::Escape($prefix))(\d+)$") { [int]$Matches[1] } } | Measure-Object -Maximum
$name = "$prefix$([int]$last.Maximum + 1).exe"
Copy-Item src-tauri\target\release\sailhighsea-vm.exe "test\$name"
Write-Host "Done -> $root\test\$name"
