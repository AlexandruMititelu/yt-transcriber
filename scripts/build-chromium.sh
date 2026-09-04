#!/bin/sh
# Assemble the Chromium (MV3) flavour in dist/chromium: same files, manifest.chromium.json as manifest.json
# (version copied from manifest.json). Load it via chrome://extensions > Load unpacked.
set -e
cd "$(dirname "$0")/.."
out=dist/chromium
rm -rf "$out" && mkdir -p "$out"
cp -r background.js content page src vendor config assets "$out/"
python3 -c "
import json
m = json.load(open('manifest.json')); c = json.load(open('manifest.chromium.json'))
c['version'] = m['version']
open('$out/manifest.json', 'w').write(json.dumps(c, indent=2) + '\n')
print('chromium', c['version'], '->', '$out')"
[ -n "$1" ] && rm -rf "$1/yt-transcriber-chromium" && cp -r "$out" "$1/yt-transcriber-chromium" && echo "copied to $1/yt-transcriber-chromium"
exit 0
