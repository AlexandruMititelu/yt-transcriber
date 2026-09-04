#!/bin/sh
# Build (optional), copy the xpi to Windows Downloads, and install it straight into Zen's profile
# (profile extensions dir, unsigned OK because xpinstall.signatures.required=false). Zen loads the
# new version on next start; --restart kills and relaunches Zen for you.
# Usage: scripts/install-xpi.sh [--build] [--restart]
set -e
cd "$(dirname "$0")/.."
win_user="${WIN_USER:-Mitit}"
zen_root="/mnt/c/Users/$win_user/AppData/Roaming/zen"
zen_exe="/mnt/c/Program Files/Zen Browser/zen.exe"
build=0; restart=0
for a in "$@"; do case "$a" in --build) build=1;; --restart) restart=1;; esac; done

if [ $build = 1 ]; then
  node --test tests/ >/dev/null 2>&1 || { echo "tests fail — not shipping (run: node --test tests/)" >&2; exit 1; }
  ./build.sh >/dev/null
fi
[ -f yt-transcriber.xpi ] || { echo "yt-transcriber.xpi missing — pass --build" >&2; exit 1; }
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")

# Default profile: the [Install*] section's Default= entry, else the profile with Default=1.
rel=$(awk -F= '/^\[Install/{f=1} f&&/^Default=/{print $2; exit}' "$zen_root/profiles.ini" | tr -d '\r')
[ -n "$rel" ] || rel=$(awk -F= '/^Path=/{p=$2} /^Default=1/{print p; exit}' "$zen_root/profiles.ini" | tr -d '\r')
profile="$zen_root/$rel"
[ -d "$profile" ] || { echo "Zen profile not found: $profile" >&2; exit 1; }

cp -f yt-transcriber.xpi "/mnt/c/Users/$win_user/Downloads/yt-transcriber.xpi"
mkdir -p "$profile/extensions"
cp -f yt-transcriber.xpi "$profile/extensions/yt-transcriber@alex.local.xpi"
echo "version $version -> Downloads + profile $(basename "$profile")"

if tasklist.exe 2>/dev/null | grep -qi '^zen.exe'; then
  if [ $restart = 1 ]; then
    taskkill.exe /IM zen.exe /F >/dev/null 2>&1 || true
    sleep 2
    (cd /mnt/c && cmd.exe /c start "" "C:\\Program Files\\Zen Browser\\zen.exe" >/dev/null 2>&1) &
    echo "Zen restarted"
  else
    echo "Zen is running: restart it to load $version (or rerun with --restart)"
  fi
else
  echo "Zen not running: new version loads on next start"
fi
