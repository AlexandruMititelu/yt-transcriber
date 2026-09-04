#!/bin/sh
# Copy yt-transcriber.xpi from WSL to the Windows Downloads folder, replacing any existing copy.
# Usage: scripts/ship-xpi.sh [--build]   (--build runs ./build.sh first: bumps version, rebuilds)
set -e
cd "$(dirname "$0")/.."
dest="/mnt/c/Users/${WIN_USER:-Mitit}/Downloads"
[ "$1" = "--build" ] && ./build.sh >/dev/null
[ -f yt-transcriber.xpi ] || { echo "yt-transcriber.xpi missing — run ./build.sh or pass --build" >&2; exit 1; }
[ -d "$dest" ] || { echo "Downloads folder not found: $dest" >&2; exit 1; }
cp -f yt-transcriber.xpi "$dest/yt-transcriber.xpi"
echo "version $(python3 -c "import json;print(json.load(open('manifest.json'))['version'])") -> C:\\Users\\${WIN_USER:-Mitit}\\Downloads\\yt-transcriber.xpi"
