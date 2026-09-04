# Installs the YT Transcriber native messaging host for Firefox / Zen / Chromium / Chrome on Windows.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File native\install.ps1
# Copies host.mjs + a launcher .bat to %LOCALAPPDATA%\yt-transcriber and registers the manifest.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'node.exe not found on PATH. Install Node.js (https://nodejs.org) first.' }

$dest = Join-Path $env:LOCALAPPDATA 'yt-transcriber'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'host.mjs') (Join-Path $dest 'host.mjs') -Force
$bat = Join-Path $dest 'host.bat'
"@echo off`r`n`"$node`" `"%~dp0host.mjs`"`r`n" | Set-Content -Path $bat -Encoding ASCII -NoNewline

$manifestPath = Join-Path $dest 'yt_transcriber.json'
$json = @{
  name = 'yt_transcriber'
  description = 'YT Transcriber file host (writes notes/chats into your knowledge base folder)'
  path = $bat
  type = 'stdio'
  allowed_extensions = @('yt-transcriber@alex.local')
} | ConvertTo-Json
# No BOM: Firefox's JSON parser rejects a BOM-prefixed manifest ("No such native application").
[IO.File]::WriteAllText($manifestPath, $json, [Text.UTF8Encoding]::new($false))

foreach ($root in 'HKCU:\Software\Mozilla\NativeMessagingHosts', 'HKCU:\Software\Zen\NativeMessagingHosts') {
  $key = Join-Path $root 'yt_transcriber'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
}

# Chromium keys the host on the extension id (fixed by "key" in manifest.chromium.json), not on allowed_extensions.
$chromiumManifestPath = Join-Path $dest 'yt_transcriber.chromium.json'
$cjson = @{
  name = 'yt_transcriber'
  description = 'YT Transcriber file host (writes notes/chats into your knowledge base folder)'
  path = $bat
  type = 'stdio'
  allowed_origins = @('chrome-extension://akcnfppmgpnlimeohhkddmanaloihnjl/')
} | ConvertTo-Json
[IO.File]::WriteAllText($chromiumManifestPath, $cjson, [Text.UTF8Encoding]::new($false))
foreach ($root in 'HKCU:\Software\Chromium\NativeMessagingHosts', 'HKCU:\Software\Google\Chrome\NativeMessagingHosts') {
  $key = Join-Path $root 'yt_transcriber'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $chromiumManifestPath
}
Write-Host "Installed. Host: $bat"
Write-Host "Manifest: $manifestPath"
Write-Host 'Restart the browser, then Settings > Test host in the extension.'
