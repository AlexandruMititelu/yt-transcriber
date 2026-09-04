# YT Transcriber

Firefox MV2 extension. Transcript, chat, and notes panel next to any YouTube video — bring your own LLM key.

- Fetches the video's caption track and shows it as timestamped segments, with chapters, search, other caption tracks and translation
- Click a segment to seek; hover for copy / "ask about this"
- Chat with the video (Anthropic or OpenAI, your API key): streamed markdown answers with mermaid diagrams, code copy buttons and clickable timestamps. Stop, retry, one-click presets, token/cost per reply and a context-window meter, optional web search. Transcripts bigger than 20% of the model's window are not sent whole: the model gets the chapter list and two tools, `search_transcript` (keyword search) and `read_transcript` (verbatim range), and pulls what it needs. Multiple chats per video, auto-titled, switchable
- Quick notes (≤280 chars, color-coded cards, always fully visible) and long-form notes (title + markdown editor), both render markdown when you click away, optional time stamps, frame captures
- Knowledge base folder (your Obsidian vault): every video gets a hub note, Transcript.md, notes and chats as markdown files, an Index.md at the root, and those files are the source of truth (edits in Obsidian win)
- Library page (sticky header) with search, sort, grouping by channel or tag, tag filter, All | Archive, full detail view, settings, JSON export/import
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

Model and thinking effort are picked in the chat composer (the picker in the input pill),
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
  Index.md                    links to every video (pinned first), rebuilt automatically
  <video title>/              created once a note or chat exists
    <video title>.md          hub note: link, channel, length, chapters, [[Transcript]], a Notes section for you; `tags:` in front matter
    Transcript.md             timestamped transcript with chapter headings
    attachments/<m-ss>.jpg    frame captures
    notes/<first line>.md     quick note (front matter: kind, time, link, color)
    notes/<title>.md          note (front matter: kind, title, link, tags inherited from the video)
    chats/<chat title>.md     one file per chat (one callout per message: you = blue info, assistant = purple example)
  Pinned/<video title>/       the same tree while pinned (hub note gets `pinned:`)
  Archive/<video title>/      the same tree while archived (hub note gets `archived:`)
```

Files win: when you open a video, the extension re-reads these folders. Edit a note in Obsidian and the
panel shows it; delete a file and the note/chat is gone; rename a chat or note file and it is renamed.
Tags, aliases or any other front-matter keys you add in Obsidian are kept. If a file changes on disk while
the panel is open, the panel reloads it instead of overwriting (toast "Changed in Obsidian").
A markdown file you write by hand in `notes/` becomes a note titled by its filename. Move a video folder
into or out of `Pinned/` or `Archive/` and the pin/archive state follows (an old lowercase `pinned/` is renamed once). The hub note's body is yours: pin/unpin only touch its
front matter.
Notes and chats you had before setting the folder are written out the first time each video is opened.

## Where data lives

Transcripts and settings live in the browser profile's `storage.local` — on the **Windows side** if the browser runs on Windows, **not** in WSL. Deleting the (temporary) add-on can drop it. Notes and chats also live there, but once a knowledge base folder is set the markdown files are the truth. Use **Export data** in Settings for a JSON backup (`yt-transcriber-export.json`, API keys left out) and **Import data** to restore it.

## Usage

- On any watch page a panel appears in the sidebar with three tabs: **Transcript | Chat | Notes**
- **Transcript**: search box filters rows; the track button switches caption tracks or translates; ⧉ copies everything; **Follow** highlights the row and underlines the exact caption line being spoken, scrolling along (a manual scroll pauses it); click a caption line to seek to it. Double-click a row (or click its timestamp) to seek; single click just selects text, so you can copy part of a segment without jumping; hover a row for copy or "ask about this" (quotes it into Chat); chapters from the description appear as headings; ⟳ refetches
- **Chat**: the dropdown at the top switches chats or starts a new one, renames or deletes (with confirmation). A new chat gets a title from the model after the first reply. Presets (Summarize, Key takeaways, …) show while a chat is empty. Edit them in Settings › Chat presets: one row per preset (shortcut + the prompt it sends), + adds one, Reset to defaults shows the defaults first and replaces everything on confirm. Pick model + effort in the pill; Enter sends, Shift+Enter for a newline; replies stream in, the send button becomes Stop (Esc too), errors offer Retry; hover a message for copy and token usage; the camera next to the model picker attaches the current video frame to your next message (also saved to the vault when a folder is set); the camera next to the model picker attaches the current video frame to your next message (also saved to the vault when a folder is set); the small percentage in the composer is how much of the model's context window the last reply used (hover for tokens) (an estimate before the first reply); answers render markdown, ```mermaid blocks become diagrams (hover for an expand button that opens the diagram full-screen on a dark backdrop, Escape closes), code blocks have a copy button, `[12:34]` timestamps are clickable seek chips
- **Notes**: "+ quick note" (≤280 chars, shown in full) or "+ note" (green; opens a title + markdown editor, "‹ Notes" goes back). Markdown renders when you click away; click text to edit. "@ time" stamps the current video time (typing `@now` does the same; `@now=t` adds the caption line being spoken, `@now=tt` the previous, current and next lines as a quote, `@now=ttt` the whole timestamp block), the color dot opens a swatch picker, ✕ clears the stamp, the camera saves the current frame into the vault and embeds it (the picture shows in view mode, read back from the vault), 🗑 asks, then deletes (Undo in the toast). Filter + sort appear once you have a few notes
- **Web search**: globe button next to Send. The model runs its own searches (Anthropic server-side tool or OpenAI built-in search), answers with a "Sources" list, links open in a new tab
- **Cheat sheet**: Settings lists every keyboard shortcut and every text shortcut and gesture (`@now` variants, `#tag`, Ctrl + right-click quotes, double-click to seek)
- **Shortcuts** (toggle in Settings): Alt+↑ / Alt+↓ switch tabs, Alt+E / Alt+V switch the note editor between raw markdown and rendered view, Alt+W toggles web search, Alt+C opens the chat list (arrows, Enter opens, Alt+Enter deletes with confirmation), Alt+Enter on the Chat tab focuses the message box, Alt+N new note, Alt+Q new quick note, Alt+Enter back to the note list / open the selected note, Alt+' / Alt+\ select previous / next note, Alt+Backspace in the notes list focuses the trash of the selected note (Enter asks, Enter again deletes; inside a note it stays the normal delete), plain Enter on a selected note opens it, Alt+T opens tagging for the selected or open note, or for the video anywhere else, Alt+Shift+Enter focus the player, Alt+F focuses transcript search
- **Quotes**: select text in a chat reply or a transcript row and Ctrl + right-click: Copy, Copy as quote, or Quote in a new note. The quote is a blockquote that links back: `[12:34](url&t=)` for transcript, `[[chats/<chat>|Chat: title]] · Assistant · 13:31` for chat (a wiki link Obsidian resolves; in the app it opens that chat)
- **+** (header) saves the video to the library without notes or chats; just watching never creates an entry
- **Tags**: the tag button in the panel header (and the **+** under the title in the Library, also on every card) tags the video; they land in the hub note's front matter as `tags:` and on its Index.md line as `#tags`, so Obsidian's tag pane, search and graph see them. Edit them in Obsidian and the app picks them up. Suggestions come from tags you already used. Library cards show them; the **Tags** pop-up in the toolbar lists every tag with counts, click to filter (several = all must match), and the grouping pop-up can group the library **By tag** next to **By channel**; search matches tags too. Every child file (notes, chats, Transcript.md) inherits the video's tags in its front matter, so `#ml` in Obsidian finds them all. A note's own tags are inline `#tags` in its text, like anywhere in Obsidian: type them, or press the **+** in the note's footer to pick from known tags (it appends `#tag` to the text, ✕ removes it); the notes tab shows them as chips and a filter row
- **Pin** (top right) moves the video's folder into `YT-transcriber/Pinned/` and turns yellow; press again to unpin. Pinned videos sit at the top of the Library, and every card has a pin
- **Archive** (box icon next to the pin, also on cards and in the detail view) moves the folder into `YT-transcriber/Archive/`; archived videos leave the main list; the **All | Archive** switch in the Library toolbar slides between the two (archiving from a card fades it out with an Undo toast), last in Index.md. Pinning an archived video unarchives it and vice versa
- **Refetch transcript** (⟳) sits in the transcript toolbar
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
background.js          HTTP proxy (CORS-free API calls, SSE streaming port) + native host bridge + library tab opener
src/lib/format.js      fmtTime, clampText, chunkText (pure)
src/lib/transcript.js  player-response extraction, track pick, json3 parse, grouping
src/lib/bus.js         runtime message helpers (call, http)
src/lib/db.js          storage.local wrapper: settings + video:<id> records
src/lib/llm.js         Anthropic/OpenAI request build/parse, system prompt, chat + transcript tools loop
src/lib/search.js      BM25 keyword search over transcript groups
src/lib/vault.js       knowledge base folder: markdown builders/parsers + disk sync via native host
src/ui/tokens.css      design tokens
src/ui/picker.js|css   model + effort popover (shared by panel and library)
src/ui/chatbar.js|css  chat switcher + confirm box (shared)
src/ui/chat.js|css     chat tab: streaming, stop/retry, presets, usage, frame capture, context meter (shared)
src/ui/notes.js|css    notes tab (shared)
src/ui/markdown.js|css markdown rendering, time chips, code copy, mermaid (shared)
src/ui/toast.js|css    toasts (shared)
config/hotkeys.js      keyboard shortcuts; config/prompts.js chat presets
native/host.mjs        Node native-messaging host (fs ops + folder dialog); install.ps1 / install.sh register it
content/yt.js|css      YouTube panel (classic script, styles scoped to #ytx-panel)
page/app.html|js|css   Library page (hash routes #/, #/video/<id>, #/settings)
tests/                 node:test suites, no network; tests/dom.js = tiny DOM stand-in, tests/smoke.test.js builds every view + all library routes against it
docs/ARCHITECTURE.md   binding contract
```

## Limitations (v1)

- No Whisper/audio fallback — videos without captions say so (age-gated / members-only / live videos explain why)
- Disk is re-read when a video is opened and checked before each write; on conflict the file wins (no merge)
- No Shorts or embedded players, no playlist context
- Single user, no i18n, no build tooling
