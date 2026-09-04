#!/bin/sh
# Register the native messaging host on Windows from WSL (runs native/install.ps1 via powershell.exe).
set -e
cd "$(dirname "$0")/.."
unc="\\\\wsl\$\\${WSL_DISTRO_NAME}$(pwd | sed 's#/#\\#g')\\native\\install.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$unc"
