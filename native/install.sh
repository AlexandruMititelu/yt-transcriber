#!/bin/sh
# Installs the YT Transcriber native messaging host for Firefox / Zen on Linux or macOS.
# Usage: ./native/install.sh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { echo "node not found on PATH. Install Node.js first." >&2; exit 1; }
case "$(uname -s)" in
  Darwin) dirs="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts $HOME/Library/Application Support/Zen/NativeMessagingHosts" ;;
  *) dirs="$HOME/.mozilla/native-messaging-hosts $HOME/.zen/native-messaging-hosts" ;;
esac
for d in $dirs; do
  mkdir -p "$d"
  cat > "$d/yt_transcriber.json" <<JSON
{
  "name": "yt_transcriber",
  "description": "YT Transcriber file host (writes notes/chats into your knowledge base folder)",
  "path": "$here/host.mjs",
  "type": "stdio",
  "allowed_extensions": ["yt-transcriber@alex.local"]
}
JSON
  echo "wrote $d/yt_transcriber.json"
done
chmod +x "$here/host.mjs"
echo "Restart the browser, then Settings > Test host in the extension."
