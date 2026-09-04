# YT Transcriber — Architecture Contract

Binding spec. Every module below is implemented EXACTLY as specified — names, shapes, keys, paths.
Firefox MV2 WebExtension. Plain JS ES modules. No TypeScript. No build step. No npm dependencies
(vendor files already committed in `vendor/`). Single user, local-first.

## File tree

```
manifest.json
background.js                 (classic script; HTTP proxy + native host bridge + library opener)
native/host.mjs               (Node native-messaging host: the only thing that touches the filesystem)
native/install.ps1 | install.sh (register the host for Firefox/Zen; NOT part of the xpi)
src/lib/format.js             (pure, ESM)
src/lib/transcript.js         (pure + fetch pipeline, ESM)
src/lib/bus.js                (runtime message helpers, ESM)
src/lib/db.js                 (storage.local wrapper, ESM)
src/lib/llm.js                (provider-agnostic LLM service, ESM)
src/lib/vault.js              (knowledge-base folder mirror: markdown builders/parsers + disk sync, ESM)
src/ui/tokens.css             (design tokens for extension pages)
src/ui/picker.js|css          (model + effort popover, shared)
src/ui/chatbar.js|css         (chat switcher bar + confirm box, shared)
src/ui/notes.js|css           (notes tab: quick notes + note editor, shared)
src/ui/icons.js               (inline SVG icons: pin, trash, chevron, eye)
config/hotkeys.js             (keyboard shortcuts: HOTKEYS list, hotkeyId(e), keysFor(id))
content/yt.js                 (content script, CLASSIC script — no top-level import/export)
content/yt.css                (panel styles, ALL rules scoped under #ytx-panel)
page/app.html                 (library full page + settings; NO inline scripts/handlers — CSP)
page/app.js                   (ES module)
page/app.css
vendor/marked.min.js          (UMD → globalThis.marked)
vendor/purify.min.js          (UMD → globalThis.DOMPurify)
vendor/mermaid.min.js         (UMD → globalThis.mermaid)
vendor/jetbrains-mono-400.woff2, vendor/jetbrains-mono-600.woff2
tests/format.test.js  tests/transcript.test.js  tests/db.test.js  tests/llm.test.js  tests/vault.test.js
README.md
docs/ARCHITECTURE.md          (this file)
```

Tests run with `node --test tests/` (node:test + node:assert/strict). Node 20. Tests import
lib modules directly; anything touching `browser.*` gets `globalThis.browser` mocked in the test.

## Message protocol (runtime.sendMessage → background)

```js
// Generic HTTP proxy (background has host permissions → no CORS).
{ type: 'http', url, method = 'GET', headers = {}, body }   // body: plain object or undefined
// → { ok: true,  status, data }            data = parsed JSON, else raw text
// → { ok: false, status?, error, data? }   error = data.error?.message || `HTTP ${status}` || exception message

{ type: 'native', op, ...args }             // → forwarded to native host `yt_transcriber` over ONE long-lived
                                            //   connectNative port (requests correlated by id); reply spread into
                                            //   { ok: true, ...reply } or { ok: false, error }
{ type: 'open-library' }                    // → { ok: true } ; background opens page/app.html in new tab
```

Native host protocol (native/host.mjs, stdio, 4-byte LE length + JSON, requests handled strictly in order):

```js
{ id, op: 'ping' }                       → { id, ok, version, platform }
{ id, op: 'pick-folder' }                → { id, ok, path | null }      // OS folder dialog (PowerShell / osascript / zenity)
{ id, op: 'list', path }                 → { id, ok, entries: [{name, dir}] }   // [] when missing
{ id, op: 'read', path }                 → { id, ok, content | null }
{ id, op: 'write', path, content }       → mkdir -p + write utf8
{ id, op: 'delete', path }               → rm -f
{ id, op: 'rename', from, to }
{ id, op: 'mkdir', path }                → mkdir -p
```
Registered as `yt_transcriber` with `allowed_extensions: ['yt-transcriber@alex.local']` (registry key
`HKCU\Software\Mozilla\NativeMessagingHosts` + Zen twin on Windows; `~/.mozilla/native-messaging-hosts` on Linux).

`background.js` (classic script, MV2 event page):
- `browser.runtime.onMessage.addListener((msg) => { ... return Promise })` — return the promise directly.
- ALLOWed URL prefixes for `http`: `https://api.anthropic.com/`, `https://api.openai.com/`.
  Anything else → `{ok:false, error:'host not allowed'}`.
- When `body` is an object: `JSON.stringify` it and set `content-type: application/json`
  (don't override a caller-provided content-type).
- `browser.browserAction.onClicked` → `browser.tabs.create({url: browser.runtime.getURL('page/app.html')})`.
- Never throw; always resolve to a `{ok, ...}` object.

## src/lib/bus.js

```js
export async function call(msg)                 // sendMessage; throws Error(r.error||'no response') unless r.ok
export async function http(url, opts = {})      // call({type:'http', url, ...opts}) → {ok, status, data}
export async function native(msg)               // call({type:'native', ...msg}); throws when the host is not installed
```

## src/lib/format.js (pure)

```js
export function fmtTime(sec)        // 65→"1:05", 3671→"1:01:11", 0→"0:00"; floors fractions
export function clampText(str, max) // ≤max chars, appends "…" when cut
export function chunkText(str, size)// array of chunks ≤size, split at whitespace when possible, no empty chunks
```

## src/lib/transcript.js

```js
export function extractPlayerResponse(html)
// Finds `ytInitialPlayerResponse = {` (optionally `var ` prefix), then a balanced-brace scan that is
// string-aware (skips braces inside "..." including \" escapes). JSON.parse the slice. null if absent.

export function extractTracks(pr)
// pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [] →
// [{ lang: languageCode, name: name?.simpleText ?? name?.runs?.[0]?.text ?? languageCode,
//    baseUrl, asr: vssId?.startsWith('a.') || kind === 'asr' }]

export function pickTrack(tracks, prefLangs = ['en'])
// preference: manual track matching prefLangs prefix → asr matching → first manual → first. null if empty.

export function parseJson3(j)
// json3 {events:[{tStartMs,dDurationMs,segs:[{utf8}]}]} → [{start, dur, text}] seconds (ms/1000),
// text = segs joined, '\n'→' ', collapse whitespace, trim; drop events with no segs/empty text.

export function groupSegments(segs, { window = 20, maxChars = 300 } = {})
// merge consecutive caption lines into display segments: close a group when
// (next.start - group.start) >= window OR group text length > maxChars.
// → [{start, end, text}] ; end = last.start + last.dur.

export async function fetchTranscript(videoId, { fetchFn = fetch } = {})
// 1. POST `https://www.youtube.com/youtubei/v1/player` {context:{client:{clientName:'ANDROID',...}}, videoId} → .json()
//    (watch-page baseUrls return empty bodies since 2025; ANDROID InnerTube URLs work without a PO token)
// 2. extractTracks → pickTrack; none → throw Error('no-captions')
// 3. GET track.baseUrl with fmt param set to json3 → .text(); empty → throw Error('no-captions'); else JSON.parse → parseJson3
// 4. → { lang, trackName: name, segments, title, channel }   (segments = raw parseJson3 output, NOT grouped;
//      title/channel = videoDetails.title/author — the panel uses them when the DOM scrape was empty)
```

## src/lib/db.js — storage.local, keys: `settings`, `video:<videoId>`, `models:<provider>`

```js
export const DEFAULT_SETTINGS = {
  anthropicKey: '', openaiKey: '',  // one key per provider; a provider "exists" iff its key is set
  model: 'anthropic:claude-sonnet-5', // '<provider>:<id>', chosen in the chat composer (both UIs)
  effort: 'off',                    // 'off'|'low'|'medium'|'high' — thinking/reasoning effort
  aboutMe: '', tone: '',            // free text, injected into the chat system prompt
  vaultDir: '',                     // knowledge base folder (Obsidian vault); '' = storage.local only
  hotkeys: true,                    // all shortcuts on/off; the list itself is fixed in config/hotkeys.js
  webSearch: false,                 // server-side web search tool; globe button in the composer
}
export async function getSettings()            // {...DEFAULT_SETTINGS, ...stored}; migrates v1 {provider, apiKey, model} → per-provider key + 'provider:model', drops legacy + notion keys
export async function saveSettings(patch)      // merge + write; returns merged
export async function getCachedModels(provider)   // ids | null (24h TTL) — key `models:<provider>` = {ids, ts}
export async function setCachedModels(provider, ids)
export async function clearCachedModels()      // both providers; Settings › Save calls it
export const NEW_CHAT_TITLE = 'New chat'
export function newChat(title = NEW_CHAT_TITLE) // → {id, title, messages: [], createdAt, updatedAt}
export function blankVideo(videoId, title = '', channel = '') // → record shape below, savedAt = Date.now()
export async function getVideo(videoId)        // record | null; migrates v1 {chat: [...], bookmarked} → chats/pinned and v2 notes.overview → a note card titled "Overview", untyped cards → kind 'quick' (in memory)
export async function saveVideo(video)         // stamps video.updatedAt = Date.now(); writes `video:<id>`; returns video
export async function deleteVideo(videoId)
export async function listVideos()
// storage.local.get(null), keys starting 'video:' → summaries sorted by updatedAt desc:
// [{videoId, title, channel, url, updatedAt, counts: {segments, messages (all chats), cards}, pinned: bool}]
```

Video record shape:

```js
{
  videoId, title, channel, url,            // url = `https://www.youtube.com/watch?v=${videoId}`
  savedAt, updatedAt,                      // epoch ms
  transcript: null | { lang, trackName, segments: [{start,dur,text}], grouped: [{start,end,text}] },
  chats: [ {id, title, messages: [ {role: 'user'|'assistant', content, ts} ], createdAt, updatedAt, file?} ],
  activeChatId: null | id,                 // last open chat, restored on reopen
  notes: { cards: [ {id, kind: 'quick'|'note', title, text, start: null|number, color: 0|1|2|3|4, ts, file?} ] },
  //   quick: ≤280 chars (QUICK_MAX in src/ui/notes.js), title unused. note: long-form markdown with a title.
  pinned: null | { at, dir },              // dir = absolute path of the video folder under YT-transcriber/pinned
  folder: null | string,                   // vault folder name, frozen on first disk write
}
```
`file` on a card/chat = basename (no .md) of its file on disk; it is the disk key during hydration.

## src/lib/llm.js

```js
export const PROVIDERS = ['anthropic', 'openai']
export const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5', openai: 'gpt-5.1' }
export const FALLBACK_MODELS = { anthropic: [...], openai: [...] }   // used when /v1/models fails
export const EFFORTS = ['off', 'low', 'medium', 'high']

export function parseModel(str)                 // 'openai:gpt-5.1' → {provider:'openai', id:'gpt-5.1'}; no ':' → anthropic
export const keyFor = (settings, provider)      // settings[`${provider}Key`] || ''
export const availableProviders = (settings)    // PROVIDERS with a non-empty key

export function webSearchTool(modelId)          // {type: 'web_search_20260209' (Claude 4.6+/5) | 'web_search_20250305', name: 'web_search', max_uses: 5}
export function buildRequest({ provider, apiKey, model, system, messages, maxTokens = 2048, effort = 'off', webSearch = false })
// webSearch → anthropic body.tools = [webSearchTool(m)]; openai body.web_search_options = {}
// messages: [{role:'user'|'assistant', content}] — plain strings.
// anthropic → { url:'https://api.anthropic.com/v1/messages',
//   headers: {'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'},
//   body: { model, max_tokens: maxTokens, system, messages } }
//   Claude 4.6+/5 (opus|sonnet-4-[6-9], opus|sonnet-5, fable, mythos): effort != 'off' →
//     body.thinking = {type:'adaptive'}, body.output_config = {effort}, max_tokens ≥ 16000;
//     effort 'off' → body.thinking = {type:'disabled'} (omitted on fable/mythos: they always think)
//   older models: effort != 'off' → body.thinking = {type:'enabled', budget_tokens: {low:4000, medium:12000, high:32000}[effort]}
//                     and max_tokens raised to budget + 4096
// openai → { url:'https://api.openai.com/v1/chat/completions',
//   headers: {'authorization': `Bearer ${apiKey}`},
//   body: { model, messages: [{role:'system',content:system}, ...messages] } }   // NO token param
//   effort != 'off' → body.reasoning_effort = effort
// model falls back to DEFAULT_MODELS[provider] when falsy. Unknown provider → throw.

export function parseResponse(provider, json)
// anthropic: text blocks joined; their `citations[].{url,title}` (web search) → "\n\nSources:\n- [title](url)" (unique urls)
// openai:    choices[0].message.content + the same block from message.annotations[type=url_citation].url_citation

export function buildSystemPrompt({ title, channel, segments, aboutMe = '', tone = '', webSearch = false })
// webSearch adds a paragraph: when to search (facts beyond the transcript), focused queries reusing the
// video's exact terms, several narrow searches, say what was found and where.
// Persona: assistant for THIS video. Includes title/channel, then optional
// 'About the user:\n<aboutMe>' and 'Tone of voice:\n<tone>' sections (skipped when blank),
// then timestamped transcript lines `[m:ss] text` from grouped segments. Whole prompt
// hard-capped at 24000 chars with '\n[transcript truncated]' (transcript is last, so it truncates).
// States: may answer with markdown; may draw diagrams in ```mermaid fenced blocks;
// cite timestamps like [12:34] when referencing the video; never use em dashes / '--'.

export async function chat({ settings, system, messages, maxTokens })
// parseModel(settings.model) → provider/id; apiKey = keyFor(settings, provider); none → throw Error('no-api-key').
// buildRequest(..., effort: settings.effort, webSearch: settings.webSearch); POST via bus.http; on !ok throw Error(error);
// anthropic stop_reason 'pause_turn' (server tool loop hit its limit) → re-POST with the partial assistant
// content appended as an assistant message (no extra user turn), at most 3 times; then parseResponse.

export function filterModelIds(provider, ids)   // openai: keep /^(gpt-\d|o\d)/, drop audio|realtime|tts|transcribe|search|instruct|image|embed|moderation|codex|dated snapshots; dedupe+sort
export async function listModels({ provider, apiKey })   // GET /v1/models (anthropic ?limit=100) via bus.http → filterModelIds; throws on !ok
export async function modelGroups(settings)     // { [provider]: ids } for availableProviders; db cache 24h, FALLBACK_MODELS on error
export function supportsEffort(provider, id)   // name heuristic: anthropic all but claude-3-0/3-5/2/instant; openai gpt-5*/o*. chat() forces effort off when false
export function resolveModel(settings, groups)  // settings.model if its provider is in groups, else `${firstProvider}:${DEFAULT_MODELS[p]}`, else settings.model
export async function titleChat({ settings, messages }) // 3-6 word title from the first exchange (effort forced off, maxTokens 30); quotes/trailing punctuation stripped, ≤60 chars
```

## src/lib/vault.js — knowledge base folder (Obsidian vault)

When `settings.vaultDir` is set, files on disk are the source of truth. Layout:

```
<vaultDir>/YT-transcriber/
  <video>/                created only when the first note or chat is written; notes/ AND chats/ are
                          both created then (even if one stays empty) so files can be added offline
    Transcript.md         front matter (ytx: transcript, id, url, lang) + "# title" + "- [m:ss](url&t=Ns) text"
                          lines; written with the folder (or on the next write once a transcript exists);
                          `video.transcriptFile` remembers the path so it is not rewritten every flush
    notes/<note>.md       one per card: front matter (ytx: note, id (uuid), kind: quick|note, title (notes only), video,
                          time, start, color, created) + text; all dates local `YYYY-MM-DD HH:mm:ss`.
                          Files without front matter (hand-written in Obsidian) = notes titled by filename.
  pinned/<video>/         the same tree while the video is pinned (pin = rename the folder here, unpin =
                          rename back; moving it by hand in Obsidian is detected on hydrate), plus
    <video>.md            summary: front matter (ytx: video, id, url, channel, pinned) + "# title" +
                          "[Watch on YouTube](url)" + "## Transcript" as "- [m:ss](url&t=Ns) text" lines
    chats/<chat>.md       front matter (ytx: chat, id (uuid), title, video, created, updated) + "# title" + messages,
                          each an Obsidian callout: "> [!user|assistant] YYYY-MM-DD HH:mm:ss" (local time)
                          followed by "> "-prefixed content lines; a non-quoted line ends the message.
                          Legacy "<!-- ytx:<role> ts=<ms> -->" marker files still parse.
```
`<video>` = `safeName(title, videoId)`, frozen in `video.folder`. Quick-note file name = first non-empty line
of the card (`Note <id8>` when blank; suffix ` 2`, ` 3` on collision), renamed when that line changes.
Note file name = its title (renaming the file in Obsidian renames the note). Chat file name = chat title. Renaming a chat
file in Obsidian renames the chat (filename wins over front matter title).

```js
export const ROOT_NAME = 'YT-transcriber', PINNED_DIR = 'pinned'
export const enabled = (settings) => !!settings.vaultDir
export function safeName(str, fallback = 'untitled', max = 80) // strips \/:*?"<>|#^[] + control chars, collapses ws, trims dots/spaces
export function noteName(card, taken = new Set())               // see above
export function chatName(chat, taken = new Set())
export function frontmatter(meta) / parseFrontmatter(md)        // minimal `key: value` YAML, JSON-quoted strings
export function noteToMd(video, card) / parseNote(md)           // parseNote → {text, start?, color?, ts?}; files without our front matter = plain notes
export function chatToMd(video, chat) / parseChat(md)           // parseChat → {title?, messages, createdAt?, updatedAt?}
export function pinToMd(video)
export const rootDir = (settings)                               // `${vaultDir}/YT-transcriber`
export const videoDir = (settings, video)                       // rootDir[/pinned]/<video> depending on video.pinned
export const ping = () / pickFolder = ()                        // native host
export async function syncNote(settings, video, card)           // write (rename first when the name changed); skips blank cards with no file
export async function removeNote(settings, video, card)
export async function syncChat(settings, video, chat)           // skips empty chats with no file
export function transcriptToMd(video) / syncTranscript(settings, video)  // <video>/Transcript.md, once per location (called from ensureDirs)
export async function removeChat(settings, video, chat)
export async function pin(settings, video)                      // throws Error('no-vault') when disabled; moves the folder under pinned/, writes the summary, sets video.pinned
export async function unpin(settings, video)                    // removes the summary, moves the folder back, clears video.pinned
export async function hydrate(settings, video)                  // disk → record (see below); no-op when disabled; throws when host missing
```
All async ops are no-ops when `enabled(settings)` is false (except `pin`, which throws `no-vault`).

`hydrate`: first decides pinned state from where the folder lives (pinned/ wins). Then lists `notes/` and
`chats/`. Every `.md` there becomes a card/chat (identity = the `id` uuid in front matter, so a rename in
Obsidian keeps the same card/chat; file name is the fallback for files without one); items
whose file disappeared are dropped; local items with NO `file` yet are written (first run after enabling).
`activeChatId` falls back to the last chat. Called by both UIs right after `getVideo`, before rendering;
a failure (host not installed) toasts once and the UI continues with storage.local data.

Write path in both UIs: model mutation → `db.saveVideo` (storage.local, debounced for typing) → the same
flush calls the matching `vault.sync*` (fire-and-forget, errors toast once per page). Disk writes are
never gen-guarded (an edit right before SPA nav must still land).

## content/yt.js — the panel (classic script)

Bootstrap: `(async () => { ... })()`. All lib access via
`await import(browser.runtime.getURL('src/lib/xxx.js'))`. Vendors via
`await import(browser.runtime.getURL('vendor/marked.min.js'))` etc — UMD sets
`globalThis.marked / DOMPurify / mermaid` in the content-script sandbox. Load mermaid lazily
(first time a mermaid block must render), marked+purify with panel init.

- Runs only on watch pages: init when `location.pathname === '/watch'`; listen
  `window.addEventListener('yt-navigate-finish', ...)` to (re)init/teardown on SPA nav.
  videoId from `new URLSearchParams(location.search).get('v')`.
- Wait for `#secondary` (poll ~250ms, ≤20s), inject `<section id="ytx-panel">` as its first child.
- Fetch `src/ui/picker.css` + `src/ui/chatbar.css` and inject them as `<style>`s (a `<link>` to moz-extension: is blocked on youtube.com; unique ytx-picker-* classes) and a `<style>` with @font-face for Geist (variable, 100-900) and JetBrains Mono using absolute
  `browser.runtime.getURL('vendor/jetbrains-mono-400.woff2')` URLs (content-script CSS can't use
  relative url()).
- Header: title "Transcript", buttons: ⟳ (refetch transcript), pin (SVG from `src/ui/icons.js`; toggles
  `vault.pin` / `vault.unpin` → save → toast; yellow #ffcc00 + filled when `video.pinned`; `no-vault` →
  toast pointing at Settings), ⧉ library (`bus.call({type:'open-library'})`).
- Apple-style segmented control tabs: **Transcript | Chat | Notes**.
- Data: `db.getVideo(id) ?? db.blankVideo(id, title, channel)` — title/channel scraped from DOM
  (`h1 yt-formatted-string` / `#owner #channel-name a`, fallback `document.title`), polled up to 6s
  (`waitForMeta`) because both lag the URL on SPA navigation; everything passes `vault.cleanTitle`, so a
  bare "YouTube" is treated as no title. `vault.videoFolder` throws `no-title` rather than freezing a
  placeholder; `hydrate` returns early; `db.getVideo` heals stored records whose title/folder is "YouTube".
  The transcript fetch also returns `videoDetails.title`, applied when the scrape was empty.
  Transcript auto-fetched on first open (spinner state), stored with BOTH raw `segments` and
  `grouped: groupSegments(segments)`; saved via db.saveVideo.
- **Transcript tab**: sticky "Follow" toggle at the top: on `timeupdate` of the page `<video>` the row whose
  start ≤ currentTime gets `.is-current` (accent-soft background) and the tab scrolls it to center (via the
  tab's own scrollTop, never scrollIntoView, which would scroll YouTube). Rows `[time chip][text]` from `grouped`. Single click → seek:
  `document.querySelector('video').currentTime = seg.start` (+ `.play()`). Double click →
  `navigator.clipboard.writeText(`[${fmtTime(seg.start)}] ${seg.text}`)` + toast "Copied".
  States: loading / error ("No captions on this video" for Error 'no-captions', retry button) / list.
- **Chat tab**: chat bar (`src/ui/chatbar.js`: a macOS-style pop-up button showing the current chat title;
  its popover lists the chats with a checkmark, then "+ New chat", then Rename / Delete chat (red);
  double-click the trigger also renames) + message list + composer (textarea; Enter sends, Shift+Enter
  newline; send button).
  Current chat = `video.chats.find(id === video.activeChatId)`; none → the first send creates one via
  `db.newChat()`. Switching drops an empty never-sent chat. Rename → inline input (Enter/blur commit,
  Esc cancel) → `vault.syncChat`. Delete → `confirmBox` replaces the message list ("Delete "<title>"?",
  Cancel / Delete) → remove chat → `vault.removeChat`. Flow per send: push user msg → saveVideo → render
  → `llm.chat({... messages: chat.messages})` → push assistant → saveVideo → `vault.syncChat` →
  if title is still NEW_CHAT_TITLE after the first exchange, `llm.titleChat` renames it (best effort).
  Assistant content rendered: `marked.parse` → `DOMPurify.sanitize` → innerHTML; then any
  `pre code.language-mermaid` (or fenced mermaid) blocks rendered to SVG via
  `mermaid.render` (init `{startOnLoad:false, securityLevel:'strict', theme: dark?'dark':'neutral'}`).
  Timestamps like `[12:34]` in assistant text become clickable seek chips (regex post-pass on the
  sanitized DOM text nodes). Errors → inline system bubble with message (e.g. no-api-key → "Add your
  API key in Settings" + library button). Disable composer while awaiting.
- **Notes tab** (`src/ui/notes.js` `createNotesView`, shared with the library): toolbar "+ quick note"
  (accent) and "+ note" (green), both with a hover tooltip explaining the difference (`HELP`). Grid:
  quick-note cards (≤280 chars with a counter, textarea auto-grows so the whole note is visible; markdown
  renders via `renderMd` when the cursor leaves, click the rendered text to edit; footer: "@ time" stamps
  `start = video.currentTime`, chip seeks, ✕ clears, color dot cycles 5 keep colors, 🗑 → `confirmBox`
  in place); note cards (green 2px outline in the list only, title + first sentence via `excerpt()`;
  click → the editor replaces the whole tab: "‹" top-left, full-width title input, body, footer with the
  time slot, an edit/view mode toggle (</> edit = permanent raw-markdown textarea, default, never flips
  on blur, no focus ring; eye = view: the rendered HTML is contenteditable and converted back to markdown
  with `htmlToMd` on every input, re-rendered on blur; mode is session-scoped; tooltips show Alt+E /
  Alt+V) and a trash button (red on hover); other tabs stay reachable; the bar is a HIG-style nav bar:
  chevron + "Notes" back button in the tint color, borderless bold title, hairline below).
  Hotkeys (config/hotkeys.js, `settings.hotkeys` gate): Alt+↑/↓ cycle Transcript · Chat · Notes, Alt+E /
  Alt+V set the editor mode via `notesView.setMode`, Alt+W selects Chat and toggles `settings.webSearch`
  (the globe inside the composer's input pill). Handled in the panel's window keydown capture
  listener and, on the library detail page, by a document listener replaced on every route. `@12:34` typed anywhere
  renders as a seek chip (panel) / time link (library), same pass as `[12:34]`. While typing,
  `normalizeStamps` rewrites `@now` to the current video time and `@2:17` to `@02:17` (caret preserved).
  Clicking empty space in the editor body focuses the field (`focusField`); `setMode` always focuses it,
  so Alt+E / Alt+V land in the editor from anywhere on the page. Every change → `onChange(card)` → debounced
  `db.saveVideo` + `vault.syncNote`; delete → `vault.removeNote`. `flush()` blurs an open textarea on teardown.
- Theme: panel colors keyed off `document.documentElement.hasAttribute('dark')` — set/remove class
  `ytx-dark` on `#ytx-panel`; watch with MutationObserver on `<html>` attributes. (Autochromatic:
  follows YouTube's own theme.)
- Toast: transient div inside panel, 1.6s fade.

## content/yt.css

ALL selectors scoped under `#ytx-panel` (plus `#ytx-panel.ytx-dark` overrides). Copy token VALUES
from src/ui/tokens.css (content CSS can't @import extension urls). Panel: rounded 16px card,
hairline border, subtle shadow, height = #movie_player height (ResizeObserver; frozen while ytd-watch-flexy[theater]), internal scroll per tab. UI chrome font =
Geist Sans; chat messages = Geist 13.5px; transcript/notes/timestamps = JetBrains Mono 12.5px. Apple details: segmented control
(pill, sliding thumb ok as background swap), accent #007aff/#0a84ff, generous whitespace,
1px `--border` hairlines, no heavy shadows.

## page/app.html / app.js / app.css — Library

`<link>` tokens.css + app.css; `<script src="../vendor/marked.min.js">`, purify, then
`<script type="module" src="app.js">`. mermaid loaded lazily by app.js via dynamic import when needed.
NO inline scripts or on* attributes (extension CSP).

Views (hash routing: `#/`, `#/video/<id>`, `#/settings`):
- **Library `#/`**: header "YT Transcriber" + Settings gear, then an All | Pinned segmented filter
  (session-scoped). All: a "Pinned" section first (when any), then "Everything else". Pinned: only pinned
  videos (empty hint otherwise). Video cards: title, channel, relative date, badges: N segments · N messages
  · N notes. Hover reveals pin + ⌫ delete (confirm()); the pin stays visible and yellow when pinned and
  toggles `vault.pin` / `vault.unpin` on the full record (`togglePin`). Click → detail.
- **Video detail `#/video/<id>`**: back button, title links to `video.url` (new tab), same three tabs
  as panel. Transcript rows: click opens `${url}&t=<floor(start)>s` in new tab; dblclick copies.
  Chat: fully functional (same llm flow — background does HTTP, so works from this page).
  Notes: same `createNotesView` (no "@ time"; chips link to `url&t=`). Pin toggle too. Hydrates from disk after first paint, like the panel.
- **Settings `#/settings`**: form — Anthropic key, OpenAI key (type=password), About me, Tone,
  Knowledge base folder (text input + "Choose…" → `vault.pickFolder` native dialog); Save button
  (db.saveSettings + clearCachedModels) + "Test Anthropic/OpenAI key" (llm.chat tiny prompt → toast),
  "Test host" (`vault.ping` → toast version/platform or error), a "Keyboard shortcuts" checkbox with the
  HOTKEYS table (kbd + description), "Export data": JSON of full storage →
  Blob download `yt-transcriber-export.json`. Inline help under the folder field explains the layout and
  the one-time `native/install.ps1` / `install.sh` step.

Shared rendering helpers may live in page/app.js — do NOT import content/ files.

## Design tokens (authoritative values in src/ui/tokens.css)

Light: bg #f5f5f7, surface #fff, surface2 #f2f2f4, text #1d1d1f, muted #6e6e73, accent #007aff,
border rgba(0,0,0,.08). Dark: bg #161617, surface #1e1e20, surface2 #2a2a2d, text #f5f5f7,
muted #98989d, accent #0a84ff, border rgba(255,255,255,.1). Radius 12 (sm 8). Keep card colors
(light/dark): 0 default surface, 1 #fff8d6/#4a4526, 2 #e2f6e3/#2a4030, 3 #e1f0ff/#243b52, 4 #fde7ef/#4a2c38.
Fonts: --font-ui "Geist" then system stack, --font-mono "JetBrains Mono" (both @font-face from vendor).

## Tests (node --test, node:assert/strict)

- format: fmtTime (0, 65, 3671, 59.9), clampText cut/no-cut, chunkText (respects size, no empties, word split).
- transcript: extractPlayerResponse (html fixture with braces inside strings + `var` form + absent),
  extractTracks/pickTrack (manual-vs-asr preference), parseJson3 fixture (newlines, empty events),
  groupSegments (window + maxChars closure, end computation).
- llm: buildRequest anthropic (url, x-api-key, version header, max_tokens, system top-level) /
  openai (bearer, system as first message, no token param), model default fallback, unknown provider throws,
  parseResponse both, buildSystemPrompt (contains title, timestamps, ≤24100 chars, truncation marker on long input).
- db: `globalThis.browser = {storage:{local:{get,set,remove}}}` Map mock; settings defaults/merge,
  save/get roundtrip, updatedAt stamped, listVideos sort + counts, delete.
- db: v1 record migration (chat[] → chats, bookmarked dropped, activeChatId set).
- vault: safeName, noteName (first line, dedupe, Overview reserved), note/chat markdown roundtrip
  (assistant text with headings/rules/comments survives), pinToMd, sync (paths, rename on title change,
  blank cards/empty chats write nothing, delete), hydrate (disk wins, local-only items get written,
  missing files drop items, stable ids), no-op without vaultDir. Native host mocked as an in-memory
  fs behind `browser.runtime.sendMessage`.
- Tests must not hit network; fetchTranscript tested via injected fetchFn returning fixtures.

## Non-goals v1 (ponytail)

No streaming responses, no Whisper/audio fallback when captions missing, no live file watching (disk is
re-read when a video is opened, not while it is open), no conflict merging (disk wins), no multi-user,
no i18n, no build tooling.
