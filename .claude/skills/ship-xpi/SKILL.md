---
name: ship-xpi
description: Build yt-transcriber.xpi (bumps patch version) and copy it to the Windows Downloads folder, replacing any existing copy. Use when the user says "ship", "build the xpi", "push to downloads", or after finishing extension changes.
---

# Ship xpi to Windows Downloads

Repo lives in WSL; the browser (Zen) runs on Windows and installs the xpi from its Downloads folder.

1. Run tests first; abort if they fail:
   ```
   node --test tests/
   ```
2. Build, copy to Downloads, and install into Zen's profile (build.sh bumps the patch version in manifest.json and zips manifest/background/src/content/page/vendor; the xpi is then copied to Downloads and to `<zen profile>/extensions/yt-transcriber@alex.local.xpi`):
   ```
   scripts/install-xpi.sh --build
   ```
   Add `--restart` to kill and relaunch Zen so the new version loads immediately (only when the user asked for a restart or said to do whatever is needed). `scripts/ship-xpi.sh` is the copy-to-Downloads-only variant.
3. Confirm the copy landed:
   ```
   ls -la /mnt/c/Users/Mitit/Downloads/yt-transcriber.xpi
   ```
4. Report the new version. If Zen was running and `--restart` was not used, say the new version loads on the next Zen restart.

Notes:
- Version bump is intentional: Firefox caches extension files when the version is unchanged.
- `native/` is not part of the xpi; the native host is installed separately via `scripts/install-host.sh` (WSL → powershell.exe → `native/install.ps1`). Re-run it whenever `native/host.mjs` changes.
