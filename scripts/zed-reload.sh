#!/usr/bin/env bash
# Zed on Windows does not notice folders created from WSL (zed-industries/zed#41614).
# There is no CLI "reload workspace", so: kill Zed and reopen this repo in it.
# ponytail: reopens as a \\wsl$ path; if you use File > Open Remote (WSL), reconnect from the UI instead.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WIN="\\\\wsl\$\\${WSL_DISTRO_NAME:-Ubuntu}$(printf '%s' "$REPO" | sed 's#/#\\#g')"
taskkill.exe /IM Zed.exe /F >/dev/null 2>&1 || true
sleep 1
zed "$WIN"
echo "Zed reopened on $WIN"
