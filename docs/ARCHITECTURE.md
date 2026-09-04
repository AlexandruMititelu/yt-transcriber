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
src/lib/search.js             (BM25 over transcript groups, pure)
src/lib/vault.js              (knowledge-base folder mirror: markdown builders/parsers + disk sync, ESM)
src/ui/tokens.css             (design tokens for extension pages)
src/ui/picker.js|css          (model + effort popover, shared)
src/ui/chatbar.js|css         (chat switcher bar + confirm box, shared)
src/ui/notes.js|css           (notes tab: quick notes + note editor, shared)
src/ui/chat.js|css            (chat tab: streaming, stop/retry, presets, usage, frame capture, context meter, shared)
src/ui/markdown.js|css        (markdown → DOM: sanitize, time chips, code copy, mermaid, shared)
src/ui/toast.js|css           (toaster: createToaster(host) → toast(msg, {link, action, error, ms}), shared)
src/ui/icons.js               (inline SVG icons: pin, trash, chevrons, eye, globe, camera, search, plus, copy, chat, refresh, library, gear, check — NO emoji/glyph icons anywhere, see .claude/skills/ui)
config/hotkeys.js             (keyboard shortcuts: HOTKEYS list, hotkeyId(e), keysFor(id))
config/prompts.js             (PROMPTS: one-click chat presets shown while a chat is empty)
assets/icon.png | logo-light.svg | logo-dark.svg  (app icon (manifest); logo-light.svg = the T used in the toolbar and both headers on every theme; logo-dark.svg = tile variant, kept unused)
content/yt.js                 (content script, CLASSIC script — no top-level import/export)
content/yt.css                (panel styles, ALL rules scoped under #ytx-panel)
page/app.html                 (library full page + settings; NO inline scripts/handlers — CSP)
page/app.js                   (ES module)
page/app.css
vendor/marked.min.js          (UMD → globalThis.marked)
vendor/purify.min.js          (UMD → globalThis.DOMPurify)
vendor/mermaid.min.js         (UMD → globalThis.mermaid)
vendor/jetbrains-mono-400.woff2, vendor/jetbrains-mono-600.woff2
tests/format.test.js  tests/transcript.test.js  tests/db.test.js  tests/llm.test.js  tests/vault.test.js  tests/notes.test.js
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

Streaming (runtime.connect port named `stream`, one per request): the page posts `{url, method, headers, body}`;
background fetches with `accept: text/event-stream`, forwards every SSE `data:` JSON as `{type:'event', event}`,
then `{type:'done'}` or `{type:'error', status?, error}`. The page disconnecting aborts the fetch (Stop button).
Same URL allow-list as `http`.

Native host protocol (native/host.mjs, stdio, 4-byte LE length + JSON, requests handled strictly in order):

```js
{ id, op: 'ping' }                       → { id, ok, version, platform }
{ id, op: 'pick-folder' }                → { id, ok, path | null }      // OS folder dialog (PowerShell / osascript / zenity)
{ id, op: 'list', root, path }           → { id, ok, entries: [{name, dir}] }   // [] when missing
{ id, op: 'read', root, path }           → { id, ok, content | null, mtime | null }   // mtime = ms
{ id, op: 'stat', root, path }           → { id, ok, mtime | null }
{ id, op: 'write', root, path, content } → mkdir -p + write utf8 → { mtime }
{ id, op: 'write-b64', root, path, data }→ mkdir -p + write bytes (frame captures)
{ id, op: 'delete', root, path }         → rm -f (files only, never recursive)
{ id, op: 'rename', root, from, to }
{ id, op: 'mkdir', root, path }          → mkdir -p
```
Every file op carries `root` (= `<vaultDir>/YT-transcriber`); `confine(root, p)` rejects any path that resolves
outside it (`path outside root`). Frames > 64 MB or unparsable JSON never wedge the host.
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
export async function http(url, opts = {})      // sendMessage({type:'http', ...}) → {ok, status?, data?, error?} — never throws (callers branch on status)
export function stream(url, opts, { onEvent, signal })  // port 'stream': onEvent(json) per SSE event → {ok} | {ok:false, status?, error}; falls back to http() without ports (tests)
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

export function groupSegments(segs, { window = 20, maxChars = 300 } = {})   // → [{start, end, text, cues: [{start, text}]}] (cues = the raw caption lines in the row)
// merge consecutive caption lines into display segments: close a group when
// (next.start - group.start) >= window OR group text length > maxChars.
// → [{start, end, text}] ; end = last.start + last.dur.

export function parseChapters(description)     // "0:00 Intro" style lines (increasing) → [{start, title}]; [] unless ≥ 2
export function explainFailure(err)            // error code → sentence: no-captions | live | unplayable: <reason> | bad-response | other

export async function fetchTranscript(videoId, { fetchFn = fetch, lang = 'en', track, translate } = {})
// 1. POST `https://www.youtube.com/youtubei/v1/player` {context:{client:{clientName:'ANDROID',...}}, videoId} → .json()
//    (watch-page baseUrls return empty bodies since 2025; ANDROID InnerTube URLs work without a PO token)
//    unparsable → 'bad-response'; playabilityStatus not OK and no captions → 'unplayable: <reason>'; live → 'live'
// 2. extractTracks → `track` {lang, asr} when given (exact), else pickTrack(tracks, [lang, 'en']); none → 'no-captions'
// 3. GET track.baseUrl + fmt=json3 (+ tlang=<translate>) → .text(); empty → 'no-captions'; JSON.parse → parseJson3
// 4. → { lang, trackName, track: {lang, asr}, translate, tracks: [{lang, name, asr}], segments, title, channel,
//        duration (s), chapters }   (segments raw, NOT grouped; title/channel from videoDetails)
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
  theme: 'auto',                    // library page: 'auto' (OS) | 'light' | 'dark' → <html data-theme>
  noteMode: 'edit',                 // note editor default mode, persisted by setMode
  follow: false,                    // transcript Follow toggle, remembered
  lang: 'en',                       // preferred caption language prefix
  prompts: undefined,               // chat presets, "Label: text" per line (config/prompts.js parsePrompts); undefined = defaults, '' = none
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
  transcript: null | { lang, trackName, track: {lang, asr}, translate: null|lang, tracks: [{lang,name,asr}],
                       duration, chapters: [{start,title}], grouped: [{start,end,text,cues:[{start,text}]}] },  // raw cues live inside grouped; records without cues are refetched on open
  chats: [ {id, title, messages: [ {role, content, ts, usage?: {in,out,cacheRead}, model?} ], createdAt, updatedAt, file?, mtime?, fm?} ],
  activeChatId: null | id,                 // last open chat, restored on reopen
  notes: { cards: [ {id, kind: 'quick'|'note', title, text, start: null|number, color: 0|1|2|3|4, ts, file?, mtime?, fm?} ] },
  //   quick: ≤280 chars (QUICK_MAX in src/ui/notes.js), title unused. note: long-form markdown with a title.
  pinned: null | { at, dir },              // dir = absolute path of the video folder under YT-transcriber/pinned
  folder: null | string,                   // vault folder name, frozen on first disk write
  transcriptFile: null | path,             // Transcript.md written for this location
  hubFile: null | path,                    // <video>/<video>.md written for this location
}
```
`file` on a card/chat = basename (no .md) of its file on disk; it is the disk key during hydration. `mtime` = the
file version last read/written (conflict guard). `fm` = verbatim front-matter lines for keys we do not own
(tags, aliases, …), re-emitted on every write.

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
export function buildRequest({ provider, apiKey, model, system, messages, maxTokens = 4096, effort = 'off', webSearch = false, streaming = false })
// webSearch → anthropic body.tools = [webSearchTool(m)]; openai body.web_search_options = {}
// streaming → body.stream = true (openai also stream_options.include_usage)
// messages: [{role:'user'|'assistant', content}] — plain strings.
// anthropic → { url:'https://api.anthropic.com/v1/messages',
//   headers: {'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'},
//   body: { model, max_tokens: maxTokens, system: [{type:'text', text: system, cache_control: {type:'ephemeral'}}], messages } }
//   (the system block = the whole transcript, identical every turn → prompt cache)
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

export function parseResponse(provider, json)   // parseResult(...).text
export function parseResult(provider, json)     // → { text, usage: {in, out, cacheRead}, truncated }
// anthropic: text blocks joined; their `citations[].{url,title}` (web search) → "\n\nSources:\n- [title](url)" (unique urls)
// openai:    choices[0].message.content + the same block from message.annotations[type=url_citation].url_citation
// stop_reason 'max_tokens' / finish_reason 'length' → truncated, text gets "*[Reply cut off: hit the length limit]*"
export function assembleAnthropic(events, onText?) / assembleOpenai(chunks, onText?)  // SSE events → the non-streaming JSON shape
export function estimateCost(modelId, usage)    // USD or null (PRICES table by substring; cache reads at 10%)
export function fmtUsage(modelId, usage)        // "12k in · 300 out · $0.041" ($ only when priced)
export function contextWindow(modelId)   // tokens by model id: 1M (Claude Opus/Sonnet 4.6+, 5.x, Fable/Mythos, GPT-4.1, GPT-5.5+), 200k other Claude, 400k GPT-5, 128k gpt-4o/o*, DEFAULT_WINDOW 128k
export const CHARS_PER_TOKEN = 3.5; export const PROMPT_SHARE = 0.2
export function contextCap(modelId)  // max transcript chars in the prompt = 20% of the window × 3.5; PROMPT_CAP = contextCap('')
export const parseTime = (v) => seconds   // 754 | "12:34" | "1:02:03"
export function transcriptTools(segments)  // → { defs: [search_transcript{query}, read_transcript{from,to}], run(name, input) → string }
// search = BM25 top 8 groups (src/lib/search.js) as `[m:ss] text` lines in time order, 'No matches. Try other words.' when empty;
// read = verbatim groups overlapping [from, to], to capped at from + 600s. Used only when promptCoverage < 1.
export function fitHistory({ modelId, system, messages, reserve = 16000 })  // → { messages, dropped }: oldest turns dropped until ~80% of the window minus system and reserve (chars/3.5, 1600/image), history opens with a user turn
export function toApiMessages(provider, messages)  // {role, content, image?} → provider shape; image (data: URL) → Anthropic base64 image block / OpenAI image_url, text after it
export const fmtK = (n) => '1.2k' | '400k' | '1M'
export function promptCoverage(segments, cap = PROMPT_CAP)  // share of the transcript that fits (1 = all)

export function buildSystemPrompt({ title, channel, segments, aboutMe = '', tone = '', webSearch = false, cap = PROMPT_CAP, retrieval = false, duration = 0, chapters = [] })
// retrieval: transcript left out; instead "[the transcript (h:mm:ss) is too big] use search_transcript … then read_transcript …"
// plus the chapter list `[m:ss] title` (or 'No chapters.'). Callers set retrieval = promptCoverage(segments, cap) < 1.
// webSearch adds a paragraph: when to search (facts beyond the transcript), focused queries reusing the
// video's exact terms, several narrow searches, say what was found and where.
// Persona: assistant for THIS video. Includes title/channel, then optional
// 'About the user:\n<aboutMe>' and 'Tone of voice:\n<tone>' sections (skipped when blank),
// then timestamped transcript lines `[m:ss] text` from grouped segments. Whole prompt
// hard-capped at `cap` chars with '\n[transcript truncated]' (safety only: retrieval mode kicks in first).
// States: may answer with markdown; may draw diagrams in ```mermaid fenced blocks;
// cite timestamps like [12:34] when referencing the video; never use em dashes / '--'.

export async function chat({ settings, system, messages, maxTokens, onText?, signal?, tools?, onTool? })   // → { text, usage, model }
// tools = transcriptTools(...): defs go in the request (Anthropic `tools`, OpenAI `type: function`); the loop runs
// them: Anthropic stop_reason 'tool_use' → assistant turn appended + user turn of tool_result blocks; OpenAI
// finish_reason 'tool_calls' → assistant message + one `tool` message per call; pause_turn as before. 10 rounds max.
// onTool(name, input) fires before each run (UI status). usage summed over rounds; text the model wrote before a
// tool call is kept in front of the final text. assembleAnthropic also keeps thinking/signature and tool_use input
// (input_json_delta → JSON on content_block_stop); assembleOpenai merges tool_calls deltas by index.
// parseModel(settings.model) → provider/id; apiKey = keyFor(settings, provider); none → throw Error('no-api-key').
// buildRequest(..., effort: settings.effort, webSearch: settings.webSearch, streaming: !!onText).
// onText → bus.stream (deltas as they arrive, assembled into the plain JSON); else bus.http. One retry after 2s on
// 429/500/502/503/529. `signal` aborted → Error('cancelled').
// anthropic stop_reason 'pause_turn' (server tool loop hit its limit) → re-POST with the partial assistant
// content appended as an assistant message (no extra user turn), at most 3 times; then parseResult.

export function filterModelIds(provider, ids)   // openai: keep /^(gpt-\d|o\d)/, drop audio|realtime|tts|transcribe|search|instruct|image|embed|moderation|codex|dated snapshots; dedupe+sort
export async function listModels({ provider, apiKey })   // GET /v1/models (anthropic ?limit=100) via bus.http → filterModelIds; throws on !ok
export async function modelGroups(settings)     // { [provider]: ids } for availableProviders; db cache 24h, FALLBACK_MODELS on error
export function supportsEffort(provider, id)   // name heuristic: anthropic all but claude-3-0/3-5/2/instant; openai gpt-5*/o*. chat() forces effort off when false
export function resolveModel(settings, groups)  // settings.model if its provider is in groups, else `${firstProvider}:${DEFAULT_MODELS[p]}`, else settings.model
export async function titleChat({ settings, messages }) // 3-6 word title from the first exchange (effort forced off, maxTokens 30, no streaming); quotes/trailing punctuation stripped, ≤60 chars
```

## src/lib/vault.js — knowledge base folder (Obsidian vault)

When `settings.vaultDir` is set, files on disk are the source of truth. Layout:

```
<vaultDir>/YT-transcriber/
  Index.md                ytx: index; "## Pinned" / "## All" lists of [[<folder>/<folder>|title]] · channel, rebuilt
                          from the hub notes on disk whenever a hub note is created or a video is pinned/unpinned
  <video>/                created only when the first note or chat is written; notes/ AND chats/ are
                          both created then (even if one stays empty) so files can be added offline
    <video>.md            hub note, written once per location (`video.hubFile`): front matter (ytx: video, id, url,
                          title, channel, duration (s), length, lang, saved, pinned (only while pinned)) + "# title",
                          "[Watch on YouTube](url)", Channel/Length, [[Transcript]], "## Chapters" (from the
                          description, linked to url&t=), "## Notes". Pin/unpin only restamp the front matter
                          (`restampHub`): the body and any user keys (tags…) stay.
    Transcript.md         front matter (ytx: transcript, id, url, title, channel, lang, track, duration) + "# title" +
                          "## <chapter>" headings + "- [m:ss](url&t=Ns) text" lines; written with the folder or when the
                          track/translation changes (`video.transcriptFile` remembers the path)
    attachments/<m-ss>.jpg  frame captures (`saveFrame`), embedded in notes as ![[attachments/<m-ss>.jpg]]
    notes/<note>.md       one per card: front matter (ytx: note, id (uuid), kind: quick|note, title (notes only), video,
                          time, start, link (url&t=Ns), color, created) + text; all dates local `YYYY-MM-DD HH:mm:ss`.
                          Any OTHER front-matter key (tags, aliases, cssclasses, lists…) is kept verbatim across writes.
                          Files without front matter (hand-written in Obsidian) = notes titled by filename.
  pinned/<video>/         the same tree while the video is pinned (pin = rename the folder here, unpin =
                          rename back; moving it by hand in Obsidian is detected on hydrate)
    chats/<chat>.md       front matter (ytx: chat, id (uuid), title, video, created, updated) + "# title" + messages,
                          each an Obsidian callout: "> [!info] You · YYYY-MM-DD HH:mm:ss" (user, blue) or
                          "> [!example] Assistant · YYYY-MM-DD HH:mm:ss" (assistant, purple; built-in types so
                          Obsidian colours them apart; the type decides the role, the word is for humans; legacy
                          `[!user]`/`[!assistant]` still parse), followed by "> "-prefixed content lines; a
                          non-quoted line ends the message. A content line that itself starts with one of those
                          tags is written as `\[!…]` and unescaped on read.
                          Legacy "<!-- ytx:<role> ts=<ms> -->" marker files still parse.
```

Conflict guard: every read/write records the file's `mtime` on the card/chat. Before a write, `put` stats the file;
if it changed since (edited in Obsidian while the panel was open) nothing is written: the file is re-parsed into the
item (`Object.assign`) and `syncNote/syncChat` resolve `'reloaded'` (else `'written'`). Both UIs re-render and toast
"Changed in Obsidian: reloaded from disk".
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
export function frontmatter(meta, extra = '') / parseFrontmatter(md)  // `key: value` YAML, JSON-quoted strings; continuation/list lines belong to the key above; → {meta, body, raw}
export function noteToMd(video, card) / parseNote(md)           // parseNote → {text, fm, kind, id?, title?, start?, color?, ts?}; files without our front matter = plain notes
export function chatToMd(video, chat) / parseChat(md)           // parseChat → {messages, fm, id?, title?, createdAt?, updatedAt?}
export function videoToMd(video, {pinnedAt}) / restampHub(md, video, {pinnedAt}) / pinToMd(video)  // hub note; pinToMd = videoToMd with pinned: now
export function indexToMd(entries) / refreshIndex(settings)    // Index.md
export async function saveFrame(settings, video, dataUrl, sec)  // → '![[attachments/<m-ss>.jpg]]'
export const rootDir = (settings)                               // `${vaultDir}/YT-transcriber`
export const videoDir = (settings, video)                       // rootDir[/pinned]/<video> depending on video.pinned
export const ping = () / pickFolder = ()                        // native host
export async function syncNote(settings, video, card)           // → 'written' | 'reloaded' (see conflict guard); rename first when the name changed; skips blank cards with no file
export async function removeNote(settings, video, card)
export async function syncChat(settings, video, chat)           // → 'written' | 'reloaded'; skips empty chats with no file
export function transcriptToMd(video) / syncTranscript(settings, video)  // <video>/Transcript.md, once per location (called from ensureDirs)
export async function removeChat(settings, video, chat)
export async function pin(settings, video)                      // throws Error('no-vault') when disabled; moves the folder under pinned/, restamps the hub note with pinned:, refreshes Index.md
export async function unpin(settings, video)                    // moves the folder back, restamps the hub note without pinned:, refreshes Index.md
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
- Fetch `src/ui/{picker,chatbar,notes,markdown,toast,chat}.css` and inject them as `<style>`s (a `<link>` to moz-extension: is blocked on youtube.com; unique ytx-picker-* classes) and a `<style>` with @font-face for Geist (variable, 100-900) and JetBrains Mono using absolute
  `browser.runtime.getURL('vendor/jetbrains-mono-400.woff2')` URLs (content-script CSS can't use
  relative url()).
- Header: logo (assets/logo-light.svg) + "YT-Trans", buttons (SVG, aria-labels): + add (only while the video has no DB record:
  sets `video.kept`, saves, hides itself), ⟳ (refetch transcript), pin (SVG from `src/ui/icons.js`; toggles
  `vault.pin` / `vault.unpin` → save → toast; yellow #ffcc00 + filled when `video.pinned`; `no-vault` →
  toast pointing at Settings), ⧉ library (`bus.call({type:'open-library'})`).
- Apple-style segmented control tabs: **Transcript | Chat | Notes** (role=tablist/tab/tabpanel, aria-selected,
  ←/→ move between tabs).
- Data: `db.getVideo(id) ?? db.blankVideo(id, title, channel)` — title/channel scraped from DOM
  (`h1 yt-formatted-string` / `#owner #channel-name a`, fallback `document.title`), polled up to 6s
  (`waitForMeta`) because both lag the URL on SPA navigation; everything passes `vault.cleanTitle`, so a
  bare "YouTube" is treated as no title. `vault.videoFolder` throws `no-title` rather than freezing a
  placeholder; `hydrate` returns early; `db.getVideo` heals stored records whose title/folder is "YouTube".
  The transcript fetch also returns `videoDetails.title`, applied when the scrape was empty.
  Transcript auto-fetched on first open (spinner state) with `settings.lang`, stored as `grouped` (+ track,
  tracks, translate, duration, chapters; raw segments dropped). Save gate: watching alone creates NO record;
  `save()` writes only when `video.kept || video.pinned || a chat has messages || notes.cards.length` (then the
  in-memory transcript is persisted too) and `vault.syncTranscript` runs under the same gate.
- **Transcript tab**: sticky toolbar: search box (filters rows as you type, matches wrapped in `<mark class="ytx-hl">`
  yellow #f5d442, Esc clears; Alt+F focuses it),
  track button (name of the current track; popover lists caption tracks and "Translate to" en/ro/nl/de/fr/es/it/pt →
  `loadTranscript(true, {track|translate})`, hidden when there is nothing to pick), copy-all (⧉, `[m:ss] text` lines),
  "Follow" toggle (persisted in `settings.follow`): on `timeupdate` of the page `<video>` the row whose
  start ≤ currentTime gets `.is-current` and the tab scrolls it to center (via the tab's own scrollTop, never
  scrollIntoView, which would scroll YouTube); a wheel/touch scroll by the user pauses Follow (toast).
  Chapter headings (`.ytx-chapter`, click seeks) are interleaved at their start times. Rows `[time chip][text]`
  from `grouped`, role=button + tabIndex (Enter/Space seek); click → seek immediately (no dblclick delay);
  hover reveals two SVG actions inline after the text (never overlaying it): copy line, and "ask" (switches to Chat
  and prefills `> [m:ss] text`).
  States: loading / error (`transcript.explainFailure(e)`, retry button) / list.
- **Chat tab** (`src/ui/chat.js` `createChatView({video, save, disk, renderMd, toast, isLive, onSynced, segments,
  settingsAction, onFrame?})` → `{root, refresh, toggleWeb, cancel, focus, prefill, isBusy}`, shared with the library): chat bar
  (`src/ui/chatbar.js`: a macOS-style pop-up button showing the current chat title; its popover lists the chats with a
  checkmark, then "+ New chat", then Rename / Delete chat (red); double-click the trigger also renames) + message list +
  composer. Composer = one pill: preset chips above (`settings.prompts` via config/prompts.js `parsePrompts`, only while
  the chat is empty), textarea
  (autosize, Enter sends, Shift+Enter newline, stays enabled while a reply streams), tool row right-aligned:
  model/effort picker · web-search globe · send circle, which becomes a Stop square while busy (Esc also stops).
  Current chat = `video.chats.find(id === video.activeChatId)`; none → the first send creates one via
  `db.newChat()`. Switching drops an empty never-sent chat. Rename → inline input → `vault.syncChat`. Delete →
  `confirmBox` replaces the message list → remove chat → `vault.removeChat`. Flow per send: push user msg →
  save → render → `llm.chat({..., onText, signal})` streams into a pending bubble ("Thinking… Ns" until the first
  delta, "(web search on)" when set) → push assistant `{content, usage, model}` → save → `vault.syncChat` → if the
  title is still NEW_CHAT_TITLE after the first exchange, `llm.titleChat` renames it (best effort). Stop keeps the
  streamed text as a message marked "*[stopped]*". Errors → inline system bubble with Retry (re-runs the same
  messages, nothing retyped); no-api-key → "Add your API key in Settings" + the host's `settingsAction()`.
  Assistant bubbles: copy button top-right, token usage `fmtUsage` shown under the bubble on hover (absolute, no
  layout cost). User bubbles: plain text, plus the captured frame `<img>` and an `@m:ss` label when the message has
  `image`/`sec`. Camera button (when `onFrame` is given, i.e. the watch page; between the picker and the globe):
  `onFrame()` → `{dataUrl, sec, embed?}` shown as a thumbnail chip above the textarea with ✕; Send attaches it to
  the user message (`image` = data: URL sent to the model via `toApiMessages`, `sec`, `embed` = Obsidian embed when
  the vault saved it) and a blank text becomes "What is shown in this frame?". The list auto-scrolls only while the
  user is at the bottom; otherwise a "↓ New reply" pill appears. Long transcripts: when
  `llm.promptCoverage(segments, llm.contextCap(model)) < 1` the system prompt is built with `retrieval: true`
  (duration + chapters, no transcript) and `llm.chat` gets `tools: llm.transcriptTools(segments)`; history goes through
  `llm.fitHistory` first (toast "N older messages left out: this chat no longer fits <model>" when it trims, e.g. after switching to a
  smaller-window model); the pending bubble
  shows "Searching transcript: q" / "Reading transcript a to b" from `onTool`. Empty chat then says the model will
  search the transcript instead (re-rendered when the picker's `onChange` fires). Context meter `.ytx-chat-ctx` at the left of the composer tools: percent of the window,
  last reply's `usage.in + usage.out` / `llm.contextWindow(model)` (tokens in the tooltip) (an estimate `~N` from the system prompt's chars/3.5 before any
  reply); orange above 80%. `usage.in` is the whole prompt on both providers (Anthropic uncached + cache read + cache
  write summed in `parseResult`). Assistant content rendered via `renderMd` =
  `src/ui/markdown.js` `renderMarkdown(text, {onSeek | timeHref})`: marked → DOMPurify (img forbidden) → links
  target=_blank → `[12:34]` / `@12:34` time chips (button that seeks on the watch page, link to url&t= in the
  library) → copy button + language tag on every code block → mermaid fences rendered lazily
  (`setDark(bool)` re-inits the theme).
- **Notes tab** (`src/ui/notes.js` `createNotesView`, shared with the library): toolbar "+ quick note"
  (accent) and "+ note" (green), both with a hover tooltip explaining the difference (`HELP`). Grid:
  quick-note cards (≤280 chars with a counter, textarea auto-grows so the whole note is visible; markdown
  renders via `renderMd` when the cursor leaves, click the rendered text to edit; footer: "@ time" stamps
  `start = video.currentTime` (library: prompts for m:ss), chip seeks, ✕ clears, color dot opens a 5-swatch
  popover, 🗑 → `confirmBox` as an overlay on the card (content stays visible) then the host toasts "Deleted"
  with an Undo action (`onUndo(card, idx)` re-inserts + re-syncs); the counter turns orange at 90% and red at
  the limit; once there are more than 3 cards the toolbar gains a filter box and an Oldest/Newest toggle; an
  empty list explains both kinds); note cards (green 2px outline in the list only, title + first sentence via `excerpt()`;
  click → the editor replaces the whole tab: "‹" top-left, full-width title input, body, footer with the
  time slot, a camera button (panel only: `onFrame()` captures the playing `<video>` frame to a canvas →
  `vault.saveFrame` → the embed is appended to the open note, or a new note "Frame at m:ss" is created from the
  list toolbar; the embed is preceded by `@mm:ss`), an edit/view mode toggle (</> edit = permanent raw-markdown textarea, default, never flips
  on blur, no focus ring; eye = view: the rendered HTML is contenteditable and converted back to markdown
  with `htmlToMd` on every input, re-rendered on blur; mode persisted in `settings.noteMode`; tooltips show Alt+E /
  Alt+V) and a trash button (red on hover); other tabs stay reachable; the bar is a HIG-style nav bar:
  chevron + "Notes" back button in the tint color, borderless bold title, hairline below).
  Hotkeys (config/hotkeys.js, `settings.hotkeys` gate): Alt+↑/↓ cycle Transcript · Chat · Notes, Alt+E /
  Alt+V set the editor mode via `notesView.setMode`, Alt+W toggles `settings.webSearch` only while the Chat tab is active
  (the globe inside the composer's input pill), Alt+C → Chat + focus the composer, Alt+N → Notes + new note
  (`notesView.addNote('note')`), Alt+Q → Notes + new quick note, Alt+Enter → `notesView.toggle()` (editor open →
  back to the list with that card selected; card selected → open it / edit it), Alt+' / Alt+\ → `notesView.move(∓1)`
  (selection cycles through the cards, wrapping; `.is-selected` ring, card focused), Alt+Shift+Enter → focus
  `#movie_player` so YouTube's own keys work, Alt+F → Transcript + focus the search box. `hotkeyId` accepts Shift
  only for Alt+Shift+Enter. Handled in the panel's window keydown capture
  listener and, on the library detail page, by a document listener replaced on every route. `@12:34` typed anywhere
  renders as a seek chip (panel) / time link (library), same pass as `[12:34]`. While typing,
  `normalizeStamps` rewrites `@now` to the current video time and `@2:17` to `@02:17` (caret preserved).
  Clicking empty space in the editor body focuses the field (`focusField`); `setMode` always focuses it,
  so Alt+E / Alt+V land in the editor from anywhere on the page. Every change → `onChange(card)` → debounced
  `db.saveVideo` + `vault.syncNote`; delete → `vault.removeNote`. `flush()` blurs an open textarea on teardown.
- Theme: panel colors keyed off `document.documentElement.hasAttribute('dark')` — set/remove class
  `ytx-dark` on `#ytx-panel`; watch with MutationObserver on `<html>` attributes. (Autochromatic:
  follows YouTube's own theme.) `markdown.setDark` keeps mermaid in step.
- Toast: `src/ui/toast.js` `createToaster(panel)` — absolute inside the panel, wraps long text, errors
  (auto-detected or `{error:true}`) stay 7s with a close button, `{action:{label,onClick}}` adds an Undo-style
  button, `{link:{href,label}}` a link; role=status aria-live=polite.
- Theater mode (`ytd-watch-flexy[theater]`, MutationObserver): the inline height is cleared and `.is-theater`
  caps the panel at 80vh / 720px wide (#secondary sits below a full-width player there).

## content/yt.css

ALL selectors scoped under `#ytx-panel` (plus `#ytx-panel.ytx-dark` overrides). Copy token VALUES
from src/ui/tokens.css (content CSS can't @import extension urls). Panel: rounded 16px card,
hairline border, subtle shadow, height = #movie_player height (ResizeObserver; capped by CSS in theater mode), internal scroll per tab.
Shared component CSS (picker, chatbar, notes, markdown, toast, chat) is injected as `<style>` and uses unique
`ytx-*` classes; the panel's button reset excludes them. `:focus-visible` rings on, mouse focus quiet,
`prefers-reduced-motion` honoured. UI chrome font =
Geist Sans; chat messages = Geist 13.5px; transcript/notes/timestamps = JetBrains Mono 12.5px. Apple details: segmented control
(pill, sliding thumb ok as background swap), accent #007aff/#0a84ff, generous whitespace,
1px `--border` hairlines, no heavy shadows.

## page/app.html / app.js / app.css — Library

`<link>` tokens.css + picker/chatbar/notes/markdown/chat/toast.css + app.css; `<script src="../vendor/marked.min.js">`,
purify, then `<script type="module" src="app.js">`. mermaid loaded lazily by src/ui/markdown.js.
NO inline scripts or on* attributes (extension CSP). Theme: `settings.theme` → `<html data-theme="light|dark">`
(absent = OS); tokens.css defines the dark palette for both `prefers-color-scheme` (unless data-theme=light) and
`[data-theme=dark]`.

Views (hash routing: `#/`, `#/video/<id>`, `#/settings`):
- **Library `#/`**: header "YT Transcriber" + Settings gear and the tools row are built ONCE per visit (`buildLibShell`);
  only the body inside `.lib-stage` is repainted (`paintLibrary`), so typing in the search box never re-creates it.
  Header = logo (assets/logo-light.svg) + name. Tools: search box (title/channel,
  debounced), sort pop-up button (label + chevron rotating 180° when open, popover with a check column: Recent |
  Title | Channel), "By channel" grouping toggle, video count (all session-scoped). All: a "Pinned" section first (when any), then "Everything
  else" (or one section per channel). Pinned: only pinned videos (empty hint otherwise). Video card = `.card-wrap`
  holding the `<a class=card>` (title, channel, relative date, badges: N segments · N messages · N notes) and a
  separate actions row (pin + ⌫ delete, faint until hover/focus, never nested in the link). Delete → `confirmBox`
  overlay on the card (library record only; vault files stay). The pin is yellow when pinned and toggles
  `vault.pin` / `vault.unpin` on the full record (`togglePin`). Click → detail.
- **Video detail `#/video/<id>`**: back button, title links to `video.url` (new tab), same three tabs
  as panel (tablist roles). Transcript: search box (matches highlighted with `<mark class="ytx-hl">`), track/length
  meta, "Copy all"; chapter headings; rows are links to `${url}&t=<floor(start)>s` (new tab) with an inline hover
  copy button after the text; no transcript → "Fetch transcript"
  button (`transcript.fetchTranscript` works from the extension page thanks to the youtube.com host permission).
  Chat: the same `createChatView` (background does HTTP, so streaming works from this page too); Esc stops via
  the route-level key handler (no per-pane document listeners). Notes: same `createNotesView` ("@ time" prompts
  for m:ss; chips link to `url&t=`; Undo toast on delete). Pin toggle too. Hydrates from disk after first paint,
  like the panel; a `'reloaded'` sync result rebuilds the panes.
- **Settings `#/settings`**: form — Anthropic key, OpenAI key (type=password with Show/Hide and a
  "● key set / ✓ key works / ✗ error" status), Appearance (Auto | Light | Dark, applied live), Caption language,
  About me, Chat presets (textarea, one "Label: prompt" per line, Reset to defaults), Tone, Knowledge base folder (text input + "Choose…" → `vault.pickFolder` native dialog); Save button
  (blue only when dirty; db.saveSettings + clearCachedModels; leaving the page with unsaved edits saves them) +
  "Test Anthropic/OpenAI key" (llm.chat tiny prompt → toast), "Test host" (`vault.ping` → toast version/platform
  or error), a "Keyboard shortcuts" checkbox with the HOTKEYS table (kbd + description), "Export data": JSON of
  storage with the API keys blanked → Blob download `yt-transcriber-export.json`; "Import data": merges an export
  back (videos + non-secret settings; keys already stored are kept). Inline help under the folder field explains
  the layout and the one-time `native/install.ps1` / `install.sh` step.

Shared rendering lives in src/ui/ (markdown, toast, chat, notes) — do NOT import content/ files.

## Design tokens (authoritative values in src/ui/tokens.css)

Light = Solarized Light: bg #eee8d5, surface #fdf6e3, surface2 #e6dfc8, text #073642, muted #657b83, accent #268bd2,
border rgba(7,54,66,.12), plus a fixed SVG fractal-noise grain layer (`--grain`, `--grain-opacity` .07; 0 in dark) over
the page body and the panel. Dark: bg #161617, surface #1e1e20, surface2 #2a2a2d, text #f5f5f7,
muted #98989d, accent #0a84ff, border rgba(255,255,255,.1). Radius 12 (sm 8). Keep card colors
(light/dark): 0 default surface, 1 #fff8d6/#4a4526, 2 #e2f6e3/#2a4030, 3 #e1f0ff/#243b52, 4 #fde7ef/#4a2c38.
Fonts: --font-ui "Geist" then system stack, --font-mono "JetBrains Mono" (both @font-face from vendor).

## Tests (node --test, node:assert/strict)

- format: fmtTime (0, 65, 3671, 59.9), clampText cut/no-cut, chunkText (respects size, no empties, word split).
- transcript: extractPlayerResponse (html fixture with braces inside strings + `var` form + absent),
  extractTracks/pickTrack (manual-vs-asr preference), parseJson3 fixture (newlines, empty events),
  groupSegments (window + maxChars closure, end computation, cues kept per row).
- llm: buildRequest anthropic (url, x-api-key, version header, max_tokens, cached system block) /
  openai (bearer, system as first message, no token param), model default fallback, unknown provider throws,
  parseResponse both, assembleAnthropic/assembleOpenai + parseResult (usage, truncation), fmtUsage, retry on 429,
  buildSystemPrompt (contains title, timestamps, ≤24100 chars, truncation marker on long input).
- transcript: parseChapters, explainFailure, fetchTranscript track/translate query params.
- db: `globalThis.browser = {storage:{local:{get,set,remove}}}` Map mock; settings defaults/merge,
  save/get roundtrip, updatedAt stamped, listVideos sort + counts, delete.
- db: v1 record migration (chat[] → chats, bookmarked dropped, activeChatId set); v2 settings keep `model`
  (regression: migrate() used to drop it).
- vault: safeName, noteName (first line, dedupe, Overview reserved), note/chat markdown roundtrip
  (assistant text with headings/rules/comments survives), pinToMd, sync (paths, rename on title change,
  blank cards/empty chats write nothing, delete), hydrate (disk wins, local-only items get written,
  missing files drop items, stable ids), no-op without vaultDir, unknown front-matter keys survive a rewrite,
  callout-header escape, disk-wins conflict (`'reloaded'`), every op carries `root`, hub note + Index.md +
  restamp on pin/unpin + saveFrame. Native host mocked as an in-memory fs (with mtimes) behind
  `browser.runtime.sendMessage`.
- Tests must not hit network; fetchTranscript tested via injected fetchFn returning fixtures.

## Non-goals v1 (ponytail)

No Whisper/audio fallback when captions missing, no live file watching (disk is re-read when a video is
opened and checked by mtime before each write; no merging: disk wins), no Shorts/embedded players, no
playlist context, no multi-user, no i18n, no build tooling.
