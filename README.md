# YT Transcriber

Firefox MV2 extension. Transcript, chat, and notes panel next to any YouTube video — bring your own LLM key.

- Fetches the video's caption track and shows it as timestamped segments
- Click a segment to seek, double-click to copy `[m:ss] text`
- Chat with the video (Anthropic or OpenAI, your API key), markdown answers with mermaid diagrams and clickable timestamps. Multiple chats per video, auto-titled, switchable
- Quick notes (≤280 chars, color-coded cards, always fully visible) and long-form notes (title + markdown editor), both render markdown when you click away, optional time stamps
- Knowledge base folder (your Obsidian vault): notes, chats and pinned videos are written as markdown files, and those files are the source of truth
- Library page with all saved videos, full detail view, settings, JSON export
- Local-first: no server, no build step

## Install in Zen / Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick `manifest.json` in this folder

**WSL users:** this repo lives in WSL; Zen/Firefox on Windows can reach it via
`\\wsl$\<distro>\home\alex\projects\my_toys\yt-transcriber-v2` in the file picker,
or copy the folder to a Windows path.

Temporary add-ons vanish on browser restart. Permanent options:

- Sign it unlisted on [AMO](https://addons.mozilla.org/developers/) and install the signed `.xpi`
- Set `xpinstall.signatures.required = false` in `about:config` (works in Zen, Developer Edition, Nightly, ESR — not release Firefox) and install the folder zipped as `.xpi`

## Setup

1. Click the toolbar button → the Library page opens
2. Go to **Settings**
3. Paste an Anthropic and/or OpenAI API key — whichever you set shows up in the model picker
4. Optional: **About me** and **Tone of voice** — both go into every chat system prompt
5. **Save**, then **Test Anthropic key** / **Test OpenAI key** to verify

Model and thinking effort are picked in the chat composer (two dropdowns above the input),
not in Settings. The model list comes from each provider's `/v1/models`, cached 24h; Save in
Settings refreshes it. Effort off = no thinking; low/medium/high = Anthropic extended thinking
budget / OpenAI `reasoning_effort`.

## Knowledge base folder (Obsidian vault)

Extensions cannot touch the filesystem, so a tiny Node native-messaging host does the writing. One-time setup:

1. Install [Node.js](https://nodejs.org) on the machine the browser runs on (Windows if Zen runs on Windows)
2. Register the host — from WSL: `scripts/install-host.sh` (runs `native\install.ps1` through powershell.exe).
   Or from a Windows PowerShell in this folder: `powershell -ExecutionPolicy Bypass -File native\install.ps1`.
   Linux/macOS: `./native/install.sh`
3. Restart the browser, open **Settings**, click **Test host**
4. **Choose…** your vault folder (or paste the path) and **Save**

Layout inside the vault:

```
<vault>/YT-transcriber/
  <video title>/              created only once a note or chat exists
    notes/<first line>.md     quick note (front matter: kind, time, color)
    notes/<title>.md          note (front matter: kind, title)
    chats/<chat title>.md     one file per chat
  pinned/<video title>/       the same tree while pinned, plus <video title>.md (title, link, transcript)
```

Files win: when you open a video, the extension re-reads these folders. Edit a note in Obsidian and the
panel shows it; delete a file and the note/chat is gone; rename a chat or note file and it is renamed.
A markdown file you write by hand in `notes/` becomes a note titled by its filename. Move a video folder
into or out of `pinned/` and the pin state follows.
Notes and chats you had before setting the folder are written out the first time each video is opened.

## Where data lives

Transcripts and settings live in the browser profile's `storage.local` — on the **Windows side** if the browser runs on Windows, **not** in WSL. Deleting the (temporary) add-on can drop it. Notes and chats also live there, but once a knowledge base folder is set the markdown files are the truth. Use **Export data** in Settings for a JSON backup (`yt-transcriber-export.json`).

## Usage

- On any watch page a panel appears in the sidebar with three tabs: **Transcript | Chat | Notes**
- **Transcript**: click a row to seek, double-click to copy the timestamped line; ⟳ refetches
- **Chat**: the dropdown at the top switches chats or starts a new one; ⋯ renames or deletes (with confirmation). A new chat gets a title from the model after the first reply. Pick model + effort above the input; Enter sends, Shift+Enter for a newline; answers render markdown, ```mermaid blocks become diagrams, `[12:34]` timestamps are clickable seek chips
- **Notes**: "+ quick note" (≤280 chars, shown in full) or "+ note" (green; opens a title + markdown editor, "‹ All notes" goes back). Markdown renders when you click away; click text to edit. "@ time" stamps the current video time, color dot cycles 5 Keep colors, ✕ clears the stamp, 🗑 asks, then deletes
- **Shortcuts** (toggle in Settings): Alt+↑ / Alt+↓ switch tabs, Alt+E / Alt+V switch the note editor between raw markdown and rendered view
- **Pin** (top right) moves the video's folder into `YT-transcriber/pinned/` and turns yellow; press again to unpin. The Library has an All | Pinned filter and a pin on every card
- **⧉** opens the Library: browse saved videos, reopen transcript/chat/notes, delete, settings

## Ship to Zen (from WSL)

```
scripts/install-xpi.sh --build            # bump version, build, copy to Downloads AND into Zen's profile
scripts/install-xpi.sh --build --restart  # same, then kill + relaunch Zen so it loads now
scripts/ship-xpi.sh --build               # copy to Downloads only
scripts/install-host.sh                   # (re)register the native host on Windows
```

The profile install drops the xpi at `<profile>/extensions/yt-transcriber@alex.local.xpi`; Zen picks up the new version on its next start (needs `xpinstall.signatures.required = false`).

## Development

No build step — plain ES modules, vendored libs in `vendor/` (marked, DOMPurify, mermaid, Geist Sans, JetBrains Mono).

```
node --test tests/
./build.sh /mnt/c/Users/Mitit/Downloads   # bumps patch version, rebuilds xpi, optional copy dest
```

File map:

```
manifest.json          MV2 manifest
background.js          HTTP proxy (CORS-free API calls) + library tab opener
src/lib/format.js      fmtTime, clampText, chunkText (pure)
src/lib/transcript.js  player-response extraction, track pick, json3 parse, grouping
src/lib/bus.js         runtime message helpers (call, http)
src/lib/db.js          storage.local wrapper: settings + video:<id> records
src/lib/llm.js         Anthropic/OpenAI request build/parse, system prompt, chat
src/lib/vault.js       knowledge base folder: markdown builders/parsers + disk sync via native host
src/ui/tokens.css      design tokens
src/ui/picker.js|css   model + effort popover (shared by panel and library)
src/ui/chatbar.js|css  chat switcher + confirm box (shared)
native/host.mjs        Node native-messaging host (fs ops + folder dialog); install.ps1 / install.sh register it
content/yt.js|css      YouTube panel (classic script, styles scoped to #ytx-panel)
page/app.html|js|css   Library page (hash routes #/, #/video/<id>, #/settings)
tests/                 node:test suites, no network
docs/ARCHITECTURE.md   binding contract
```

## Limitations (v1)

- No streaming responses
- No Whisper/audio fallback — videos without captions show "No captions on this video"
- Disk is re-read when a video is opened, not watched live; on conflict the file wins
- Single user, no i18n, no build tooling
