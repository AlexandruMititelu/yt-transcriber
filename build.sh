#!/bin/sh
# Zip the extension into yt-transcriber.xpi (no build step, xpi = zip).
# Usage: ./build.sh [copy-dest-dir]
set -e
cd "$(dirname "$0")"
rm -f yt-transcriber.xpi
python3 - <<'PY'
import zipfile, os, json, re
# Bump patch version: Firefox keeps cached copies of extension files when the version is unchanged.
m = json.load(open('manifest.json'))
a, b, c = m['version'].split('.')
m['version'] = f'{a}.{b}.{int(c) + 1}'
open('manifest.json', 'w').write(json.dumps(m, indent=2) + '\n')
print('version', m['version'])
z = zipfile.ZipFile('yt-transcriber.xpi', 'w', zipfile.ZIP_DEFLATED)
for root in ['manifest.json', 'background.js', 'content', 'page', 'src', 'vendor', 'config', 'assets']:
    if os.path.isfile(root):
        z.write(root)
    else:
        for d, _, fs in os.walk(root):
            for f in fs:
                z.write(os.path.join(d, f))
z.close()
PY
[ -n "$1" ] && cp yt-transcriber.xpi "$1/"
ls -la yt-transcriber.xpi
