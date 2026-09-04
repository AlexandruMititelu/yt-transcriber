// Knowledge-base folder (Obsidian vault) mirror. Disk is the source of truth when settings.vaultDir is set:
//   <vaultDir>/YT-transcriber/<video>/notes/<note>.md  one file per card (quick note or note)
//   <vaultDir>/YT-transcriber/<video>/chats/<chat>.md  one file per chat
//   <vaultDir>/YT-transcriber/Pinned/<video>/...       the same tree, moved here while the video is pinned
//   <vaultDir>/YT-transcriber/Archive/<video>/...      … or archived (one location at a time; the hub note is stamped)
// Pure builders/parsers are exported for tests; async ops go through the native host (bus.native).

import { native } from './bus.js';
import { parseTagList } from './tags.js';
import { fmtTime } from './format.js';

export const ROOT_NAME = 'YT-transcriber';
export const PINNED_DIR = 'Pinned';
export const ARCHIVE_DIR = 'Archive';
const LOCS = ['', PINNED_DIR, ARCHIVE_DIR];
export const locOf = (video) => (video.archived ? ARCHIVE_DIR : video.pinned ? PINNED_DIR : '');

export const enabled = (settings) => !!(settings && settings.vaultDir);

// Filesystem + Obsidian-link safe name. Windows-reserved chars, Obsidian link chars, control chars.
export function safeName(str, fallback = 'untitled', max = 80) {
  const s = String(str ?? '')
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, max)
    .trim();
  return s || fallback;
}

// Notes are named by title, quick notes by their first line.
export function noteName(card, taken = new Set()) {
  const first = (card.text || '').split('\n').find((l) => l.trim()) || '';
  const base = safeName(card.kind === 'note' && card.title ? card.title : first, `Note ${String(card.id || '').slice(0, 8)}`, 60);
  let name = base;
  for (let i = 2; taken.has(name) && name !== card.file; i++) name = `${base} ${i}`;
  return name;
}

export function chatName(chat, taken = new Set()) {
  const base = safeName(chat.title, `Chat ${String(chat.id || '').slice(0, 8)}`, 60);
  let name = base;
  for (let i = 2; taken.has(name) && name !== chat.file; i++) name = `${base} ${i}`;
  return name;
}

const yamlStr = (s) => JSON.stringify(String(s ?? ''));
// All dates on disk are local time (the browser's zone), `YYYY-MM-DD HH:mm:ss`, human readable.
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (ms) => {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const parseStamp = (str) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str || '').trim());
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const t = Date.parse(str); // legacy ISO
  return Number.isNaN(t) ? 0 : t;
};
const iso = localStamp;

// `extra` = raw YAML lines for keys we don't own (tags, aliases, cssclasses… added in Obsidian), re-emitted verbatim.
export function frontmatter(meta, extra = '') {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : Array.isArray(v) ? `[${v.join(', ')}]` : yamlStr(v)}`);
  if (extra) lines.push(extra.replace(/\s+$/, ''));
  return `---\n${lines.join('\n')}\n---\n`;
}

// Minimal front matter reader: `key: value` lines, JSON/quoted strings unwrapped; indented / `- item`
// lines belong to the key above. → { meta, body, raw: {key: 'verbatim lines'} }
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md, raw: {} };
  const meta = {};
  const raw = {};
  let k = null;
  for (const line of m[1].split(/\r?\n/)) {
    const head = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!head) { if (k) raw[k] += `\n${line}`; continue; }
    k = head[1];
    raw[k] = line;
    let v = head[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    meta[k] = v;
  }
  return { meta, body: md.slice(m[0].length), raw };
}

// Raw lines of every key not in `own`, joined: what we carry across a rewrite.
const extraOf = (raw, own) => Object.keys(raw).filter((k) => !own.has(k)).map((k) => raw[k]).join('\n');
const NOTE_KEYS = new Set(['ytx', 'id', 'kind', 'title', 'video', 'time', 'start', 'link', 'color', 'created', 'tags']);
const CHAT_KEYS = new Set(['ytx', 'id', 'title', 'video', 'created', 'updated', 'tags']);
const TRANSCRIPT_KEYS = new Set(['ytx', 'id', 'url', 'title', 'channel', 'lang', 'track', 'duration', 'tags']);
// Children (notes, chats, Transcript.md) inherit the video's tags; a child may carry extra ones of its own.
const childTags = (video, own) => { const t = [...new Set([...(video.tags ?? []), ...(own ?? [])])]; return t.length ? t : undefined; };
const ownTags = (video, disk) => (disk ?? []).filter((t) => !(video.tags ?? []).includes(t));

export function noteToMd(video, card) {
  return frontmatter({
    ytx: 'note',
    id: card.id,
    kind: card.kind === 'note' ? 'note' : 'quick',
    title: card.kind === 'note' ? card.title : undefined,
    video: video.url,
    time: card.start == null ? undefined : fmtTime(card.start),
    start: card.start == null ? undefined : Math.floor(card.start),
    link: card.start == null ? undefined : `${video.url}&t=${Math.floor(card.start)}s`,
    color: card.color || 0,
    created: iso(card.ts),
    tags: childTags(video, card.tags),
  }, card.fm) + (card.text || '');
}

// → partial card {text, kind, title?, start?, color?, ts?}. Files without our front matter (written by
// hand in Obsidian) are long-form notes; legacy ytx files without `kind` are quick notes.
export function parseNote(md) {
  const { meta, body, raw } = parseFrontmatter(md);
  const out = { text: body.replace(/\s+$/, ''), fm: extraOf(raw, NOTE_KEYS), tags: tagsOf(meta, raw) ?? [] };
  if (meta.ytx !== 'note') { out.kind = 'note'; return out; }
  out.kind = meta.kind === 'note' ? 'note' : 'quick';
  if (meta.id) out.id = String(meta.id);
  if (meta.title) out.title = String(meta.title);
  if (typeof meta.start === 'number') out.start = meta.start;
  else out.start = null;
  if (typeof meta.color === 'number') out.color = meta.color;
  if (meta.created) { const t = parseStamp(meta.created); if (t) out.ts = t; }
  return out;
}

// Chat body = one Obsidian callout per message: `> [!info] You · 2026-09-04 13:31:26` then `> `-prefixed
// content. Built-in callout types so Obsidian colours them apart (info = blue, example = purple); the role
// word in the title is for humans, the type decides the role. Legacy `[!user]` / `[!assistant]` still parse.
// Header = exactly the tag, optional role word, optional stamp; anything else after the tag is content.
const ROLE_TAG = { user: 'info', assistant: 'example' };
const ROLE_WORD = { user: 'You', assistant: 'Assistant' };
const TAG_ROLE = { info: 'user', example: 'assistant', user: 'user', assistant: 'assistant' };
const CALLOUT = /^> \[!(user|assistant|info|example)\](?: (?:You|Assistant))?(?: ·)?(?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?$/;
const TAG_ESC = /^\[!(user|assistant|info|example)\]/;
// Legacy (v1 files): `<!-- ytx:user ts=123 -->` markers with `### You|Assistant` headings.
const MSG_MARK = /^<!-- ytx:(user|assistant) ts=(\d+) -->[ \t]*\r?\n(?:### (?:You|Assistant)[ \t]*\r?\n)?/gm;

export function chatToMd(video, chat) {
  const head = frontmatter({
    ytx: 'chat',
    id: chat.id,
    title: chat.title,
    video: video.url,
    created: iso(chat.createdAt),
    updated: iso(chat.updatedAt),
    tags: childTags(video, chat.tags),
  }, chat.fm);
  const body = chat.messages.map((m) => {
    // A content line that looks like a callout header would parse as a new message: escape the bracket.
    const lines = ((m.embed ? m.embed + '\n' : '') + String(m.content)).replace(/\s+$/, '').split('\n')
      .map((l) => l.replace(TAG_ESC, '\\[!$1]'))
      .map((l) => (l ? `> ${l}` : '>'));
    return `> [!${ROLE_TAG[m.role] || m.role}] ${ROLE_WORD[m.role] || m.role} · ${localStamp(m.ts)}\n${lines.join('\n')}\n`;
  }).join('\n');
  return `${head}# ${chat.title}\n\n${body}`;
}

function parseCallouts(body) {
  const messages = [];
  let cur = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const head = CALLOUT.exec(line);
    if (head) {
      cur = { role: TAG_ROLE[head[1]], ts: parseStamp(head[2]), lines: [] };
      messages.push(cur);
    } else if (cur && line.startsWith('>')) {
      cur.lines.push(line.replace(/^> ?/, '').replace(/^\\\[!(user|assistant|info|example)\]/, '[!$1]'));
    } else {
      cur = null; // first non-quoted line closes the callout
    }
  }
  return messages.map(({ role, ts, lines }) => {
    const embed = /^!\[\[attachments\/[^\]]+\]\]$/.test(lines[0] ?? '') ? lines.shift() : null; // frame capture (chat camera)
    return { role, ts, content: lines.join('\n').replace(/\s+$/, ''), ...(embed ? { embed } : {}) };
  });
}

function parseMarkers(body) {
  const messages = [];
  const marks = [...body.matchAll(MSG_MARK)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    messages.push({ role: m[1], ts: Number(m[2]) || 0, content: body.slice(start, end).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '') });
  });
  return messages;
}

// → { title?, messages: [{role, content, ts}], createdAt?, updatedAt? }
export function parseChat(md) {
  const { meta, body, raw } = parseFrontmatter(md);
  let messages = parseCallouts(body);
  if (!messages.length) messages = parseMarkers(body);
  const out = { messages, fm: extraOf(raw, CHAT_KEYS), tags: tagsOf(meta, raw) ?? [] };
  if (meta.id) out.id = String(meta.id);
  if (meta.title) out.title = String(meta.title);
  for (const [k, f] of [['created', 'createdAt'], ['updated', 'updatedAt']]) {
    const t = meta[k] ? parseStamp(meta[k]) : 0;
    if (t) out[f] = t;
  }
  return out;
}

const HUB_KEYS = new Set(['ytx', 'id', 'url', 'title', 'channel', 'duration', 'length', 'lang', 'saved', 'pinned', 'archived', 'tags']);
// `tags` from a hub note's front matter in whatever spelling Obsidian left it (flow list, block list, plain).
export const tagsOf = (meta, raw) => ('tags' in raw ? parseTagList(raw.tags.includes('\n') ? raw.tags : meta.tags) : null);
const hubMeta = (video, pinnedAt, archivedAt) => ({
  ytx: 'video',
  id: video.videoId,
  url: video.url,
  title: video.title || video.videoId,
  channel: video.channel,
  duration: video.transcript?.duration || undefined, // seconds, Dataview-friendly
  length: video.transcript?.duration ? fmtTime(video.transcript.duration) : undefined,
  lang: video.transcript?.lang,
  saved: iso(video.savedAt),
  pinned: pinnedAt ? iso(pinnedAt) : undefined,
  archived: archivedAt ? iso(archivedAt) : undefined,
  tags: video.tags?.length ? video.tags : undefined,
});

// <video>/<video>.md — the hub note every video gets: title, link, chapters, link to Transcript.md.
// Body is the user's after the first write; pin/unpin only touch the front matter.
export function videoToMd(video, { pinnedAt = video.pinned?.at, archivedAt = video.archived?.at } = {}) {
  const lines = [`# ${video.title || video.videoId}`, '', `[Watch on YouTube](${video.url})`];
  if (video.channel) lines.push(`Channel: ${video.channel}`);
  if (video.transcript?.duration) lines.push(`Length: ${fmtTime(video.transcript.duration)}`);
  lines.push('', '[[Transcript]]');
  const chapters = video.transcript?.chapters ?? [];
  if (chapters.length) {
    lines.push('', '## Chapters', '');
    for (const c of chapters) lines.push(`- [${fmtTime(c.start)}](${video.url}&t=${Math.floor(c.start)}s) ${c.title}`);
  }
  lines.push('', '## Notes', '');
  return frontmatter(hubMeta(video, pinnedAt, archivedAt)) + lines.join('\n') + '\n';
}

// Re-stamp our front matter on an existing hub note, keeping the body and any user keys verbatim.
// Tags on disk win (edited in Obsidian) unless the caller is writing a tag change (`tagsFromApp`).
export function restampHub(md, video, { pinnedAt = video.pinned?.at, archivedAt = video.archived?.at, tagsFromApp = false } = {}) {
  const { meta, body, raw } = parseFrontmatter(md);
  const disk = tagsOf(meta, raw);
  if (disk && !tagsFromApp) video.tags = disk;
  return frontmatter(hubMeta(video, pinnedAt, archivedAt), extraOf(raw, HUB_KEYS)) + body;
}

// Legacy name kept for callers/tests: the pin summary is now the hub note with `pinned:` set.
export const pinToMd = (video) => videoToMd(video, { pinnedAt: Date.now() });

// YT-transcriber/Index.md: one line per video folder: Pinned first, then All, Archive last. Built from what is on disk.
export function indexToMd(entries) {
  const locFor = (e) => e.loc ?? (e.pinned ? PINNED_DIR : '');
  const row = (e) => `- [[${locFor(e) ? `${locFor(e)}/` : ''}${e.folder}/${e.folder}|${e.title || e.folder}]]${e.channel ? ` · ${e.channel}` : ''}${e.tags?.length ? ' ' + e.tags.map((t) => `#${t}`).join(' ') : ''}`;
  const pinned = entries.filter((e) => locFor(e) === PINNED_DIR);
  const archived = entries.filter((e) => locFor(e) === ARCHIVE_DIR);
  const rest = entries.filter((e) => !locFor(e));
  const lines = ['# YT Transcriber', ''];
  const sectioned = pinned.length || archived.length;
  if (pinned.length) lines.push('## Pinned', '', ...pinned.map(row), '');
  lines.push(rest.length && sectioned ? '## All' : '', ...(rest.length && sectioned ? [''] : []), ...rest.map(row));
  if (archived.length) lines.push('', '## Archive', '', ...archived.map(row));
  return frontmatter({ ytx: 'index', updated: iso(Date.now()) }) + lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n') + '\n';
}

/* ---------- paths ---------- */

const join = (...parts) => parts.join('/');
export const rootDir = (settings) => join(String(settings.vaultDir).replace(/[\\/]+$/, ''), ROOT_NAME);
// A title is real only once YouTube's SPA navigation has filled it in; "YouTube" (bare document.title)
// or blank must never become a folder name. Freeze the folder only from a real title.
export function cleanTitle(title) {
  const t = String(title ?? '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  return /^youtube$/i.test(t) ? '' : t;
}
export const hasTitle = (video) => !!cleanTitle(video.title);

function videoFolder(video) {
  if (!video.folder) {
    const t = cleanTitle(video.title);
    if (!t) throw new Error('no-title');
    video.folder = safeName(t, video.videoId);
  }
  return video.folder;
}
// loc = '' (root) | PINNED_DIR | ARCHIVE_DIR
const videoDirAt = (settings, video, loc) => (loc ? join(rootDir(settings), loc, videoFolder(video)) : join(rootDir(settings), videoFolder(video)));
export const videoDir = (settings, video) => videoDirAt(settings, video, locOf(video));
const notesDir = (settings, video) => join(videoDir(settings, video), 'notes');
const chatsDir = (settings, video) => join(videoDir(settings, video), 'chats');
const hubPath = (settings, video) => join(videoDir(settings, video), `${videoFolder(video)}.md`);
const indexPath = (settings) => join(rootDir(settings), 'Index.md');

/* ---------- async ops (native host) ---------- */

export const ping = () => native({ op: 'ping' });
export const pickFolder = async () => (await native({ op: 'pick-folder' })).path;
// Every file op carries the vault root; the host refuses paths outside it (defence in depth).
const io = (settings, msg) => native({ root: rootDir(settings), ...msg });

async function listMd(settings, dir) {
  const { entries } = await io(settings, { op: 'list', path: dir });
  return entries.filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3));
}

// Both subfolders exist as soon as the video has anything on disk, so notes can be written
// offline in Obsidian and picked up next time.
async function ensureDirs(settings, video) {
  await io(settings, { op: 'mkdir', path: notesDir(settings, video) });
  await io(settings, { op: 'mkdir', path: chatsDir(settings, video) });
  await syncTranscript(settings, video);
  await ensureHub(settings, video);
}

// Hub note written once per folder location (video.hubFile remembers it); Index.md refreshed after.
async function ensureHub(settings, video) {
  const path = hubPath(settings, video);
  if (video.hubFile === path) return;
  const { content } = await io(settings, { op: 'read', path });
  if (content == null) {
    await io(settings, { op: 'write', path, content: videoToMd(video) });
    await refreshIndex(settings).catch(() => {}); // best effort
  }
  video.hubFile = path;
}

// Tags changed in the app → restamp the hub note's front matter (body untouched) and refresh Index.md.
export async function syncTags(settings, video) {
  if (!enabled(settings)) return;
  await ensureDirs(settings, video);
  const path = hubPath(settings, video);
  const { content } = await io(settings, { op: 'read', path });
  if (content != null) await io(settings, { op: 'write', path, content: restampHub(content, video, { tagsFromApp: true }) });
  // Children inherit: rewrite every note and chat file, restamp Transcript.md.
  for (const c of video.notes.cards) await syncNote(settings, video, c);
  for (const c of video.chats) await syncChat(settings, video, c);
  const tp = join(videoDir(settings, video), 'Transcript.md');
  const tr = await io(settings, { op: 'read', path: tp });
  if (tr.content != null) await io(settings, { op: 'write', path: tp, content: restampTranscript(tr.content, video) });
  await refreshIndex(settings).catch(() => {});
}

// Older vaults have a lowercase `pinned/`: rename it once (Windows is case-insensitive, so `Pinned` already resolves,
// but the listing must show the proper name and Linux/macOS need the real rename).
const casedRoots = new Set();
async function fixCase(settings) {
  const root = rootDir(settings);
  if (casedRoots.has(root)) return;
  casedRoots.add(root);
  const { entries } = await io(settings, { op: 'list', path: root });
  for (const e of entries) {
    const want = LOCS.find((l) => l && l.toLowerCase() === e.name.toLowerCase());
    if (e.dir && want && e.name !== want) await io(settings, { op: 'rename', from: join(root, e.name), to: join(root, want) }).catch(() => {});
  }
}

// Scan root + Pinned/ + Archive/ for hub notes and rewrite Index.md.
export async function refreshIndex(settings) {
  if (!enabled(settings)) return;
  await fixCase(settings);
  const entries = [];
  const special = new Set(LOCS.filter(Boolean).map((l) => l.toLowerCase()));
  for (const loc of LOCS) {
    const base = loc ? join(rootDir(settings), loc) : rootDir(settings);
    const { entries: ents } = await io(settings, { op: 'list', path: base });
    for (const e of ents) {
      if (!e.dir || (!loc && special.has(e.name.toLowerCase()))) continue;
      const { content } = await io(settings, { op: 'read', path: join(base, e.name, `${e.name}.md`) });
      if (content == null) continue;
      const { meta, raw } = parseFrontmatter(content);
      entries.push({ folder: e.name, loc, pinned: loc === PINNED_DIR, title: meta.title || e.name, channel: meta.channel || '', tags: tagsOf(meta, raw) ?? [] });
    }
  }
  entries.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  await io(settings, { op: 'write', path: indexPath(settings), content: indexToMd(entries) });
}

// A video frame (data: URL from a canvas) → <video>/attachments/<m-ss>.jpg; returns the Obsidian embed.
export async function saveFrame(settings, video, dataUrl, sec) {
  if (!enabled(settings)) throw new Error('no-vault');
  await ensureDirs(settings, video);
  const name = `${fmtTime(sec).replace(/:/g, '-')}.jpg`;
  const path = join(videoDir(settings, video), 'attachments', name);
  const data = String(dataUrl).replace(/^data:[^,]*,/, '');
  await io(settings, { op: 'write-b64', path, data });
  return `![[attachments/${name}]]`;
}

export function transcriptToMd(video) {
  const grouped = video.transcript?.grouped ?? [];
  const t = video.transcript ?? {};
  const chapters = t.chapters ?? [];
  const body = [];
  let ci = 0;
  for (const s of grouped) {
    while (ci < chapters.length && chapters[ci].start <= s.start) { body.push('', `## ${chapters[ci].title}`, ''); ci++; }
    body.push(`- [${fmtTime(s.start)}](${video.url}&t=${Math.floor(s.start)}s) ${s.text}`);
  }
  return frontmatter(transcriptMeta(video)) + `# ${video.title || video.videoId}\n${body.join('\n').replace(/^\n+/, '\n')}\n`;
}
const transcriptMeta = (video) => {
  const t = video.transcript ?? {};
  return {
    ytx: 'transcript', id: video.videoId, url: video.url, title: video.title || video.videoId, channel: video.channel,
    lang: t.lang, track: t.trackName, duration: t.duration || undefined, tags: childTags(video),
  };
};
// Re-stamp Transcript.md's front matter (tags) keeping the body and user keys.
export function restampTranscript(md, video) {
  const { body, raw } = parseFrontmatter(md);
  return frontmatter(transcriptMeta(video), extraOf(raw, TRANSCRIPT_KEYS)) + body;
}

// <video>/Transcript.md, written once the transcript exists (video.transcriptFile remembers the location).
export async function syncTranscript(settings, video) {
  if (!enabled(settings) || !video.transcript?.grouped?.length) return;
  const path = join(videoDir(settings, video), 'Transcript.md');
  if (video.transcriptFile === path) return;
  await io(settings, { op: 'write', path, content: transcriptToMd(video) });
  video.transcriptFile = path;
}

// Write (or rename+write) one file under `dir`; `owner.file` is the disk key, `owner.mtime` the version we
// last saw. If the file changed on disk since (edited in Obsidian), disk wins: `onDisk(content)` reloads
// the owner and nothing is written. → 'written' | 'reloaded'
async function put(settings, dir, owner, name, content, onDisk) {
  if (owner.file && owner.mtime) {
    const cur = join(dir, `${owner.file}.md`);
    const { mtime } = await io(settings, { op: 'stat', path: cur });
    if (mtime && mtime !== owner.mtime) {
      const r = await io(settings, { op: 'read', path: cur });
      if (r.content != null) { onDisk(r.content); owner.mtime = r.mtime || mtime; return 'reloaded'; }
    }
  }
  if (owner.file && owner.file !== name) {
    await io(settings, { op: 'rename', from: join(dir, `${owner.file}.md`), to: join(dir, `${name}.md`) });
  }
  const r = await io(settings, { op: 'write', path: join(dir, `${name}.md`), content });
  owner.file = name;
  owner.mtime = r.mtime || null;
  return 'written';
}

async function drop(settings, dir, owner) {
  if (!owner.file) return;
  await io(settings, { op: 'delete', path: join(dir, `${owner.file}.md`) });
  owner.file = null;
  owner.mtime = null;
}

const takenExcept = (items, me) => new Set(items.filter((x) => x !== me && x.file).map((x) => x.file));

export async function syncNote(settings, video, card) {
  if (!enabled(settings)) return;
  if (!card.file && !(card.text || '').trim() && !(card.title || '').trim()) return; // don't create files for blank cards
  await ensureDirs(settings, video);
  return put(settings, notesDir(settings, video), card, noteName(card, takenExcept(video.notes.cards, card)), noteToMd(video, card),
    (md) => Object.assign(card, parseNote(md)));
}

export async function removeNote(settings, video, card) {
  if (enabled(settings)) await drop(settings, notesDir(settings, video), card);
}

export async function syncChat(settings, video, chat) {
  if (!enabled(settings)) return;
  if (!chat.file && !chat.messages.length) return;
  await ensureDirs(settings, video);
  return put(settings, chatsDir(settings, video), chat, chatName(chat, takenExcept(video.chats, chat)), chatToMd(video, chat),
    (md) => Object.assign(chat, parseChat(md)));
}

export async function removeChat(settings, video, chat) {
  if (enabled(settings)) await drop(settings, chatsDir(settings, video), chat);
}

async function dirExists(settings, dir) {
  const { entries } = await io(settings, { op: 'list', path: dir });
  return entries.length > 0;
}

// Move the whole video folder between root / Pinned / Archive; the hub note gets `pinned:` / `archived:` stamped.
async function moveTo(settings, video, loc) {
  if (!enabled(settings)) throw new Error('no-vault');
  await fixCase(settings);
  const from = videoDir(settings, video);
  const to = videoDirAt(settings, video, loc);
  if (from !== to && (await dirExists(settings, from))) await io(settings, { op: 'rename', from, to });
  const now = Date.now();
  video.pinned = loc === PINNED_DIR ? { at: now, dir: to } : null;
  video.archived = loc === ARCHIVE_DIR ? { at: now, dir: to } : null;
  video.transcriptFile = null; // moved with the folder; re-stamp under the new path
  video.hubFile = null;
  if (loc) await ensureDirs(settings, video);
  await stampHub(settings, video);
  await refreshIndex(settings).catch(() => {});
  return to;
}
export const pin = (settings, video) => moveTo(settings, video, PINNED_DIR);
export const unpin = (settings, video) => moveTo(settings, video, '');
export const archive = (settings, video) => moveTo(settings, video, ARCHIVE_DIR);
export const unarchive = (settings, video) => moveTo(settings, video, '');

async function stampHub(settings, video) {
  const path = hubPath(settings, video);
  const { content } = await io(settings, { op: 'read', path });
  await io(settings, { op: 'write', path, content: content == null ? videoToMd(video) : restampHub(content, video) });
  video.hubFile = path;
}

// Disk → record. Files win for anything that has a file; local items without a file get written
// (first run after enabling the vault). Mutates `video`; caller saves. Throws if the host is missing.
export async function hydrate(settings, video) {
  if (!enabled(settings)) return;
  if (!video.folder && !hasTitle(video)) return; // nothing on disk can belong to a video we can't name yet
  // Where the folder actually lives decides pinned / archived state (moving it in Obsidian does the same).
  await fixCase(settings);
  let where = null;
  for (const loc of [ARCHIVE_DIR, PINNED_DIR, '']) if (await dirExists(settings, videoDirAt(settings, video, loc))) { where = loc; break; }
  if (where != null && where !== locOf(video)) {
    video.pinned = where === PINNED_DIR ? { at: video.pinned?.at || Date.now(), dir: videoDirAt(settings, video, where) } : null;
    video.archived = where === ARCHIVE_DIR ? { at: video.archived?.at || Date.now(), dir: videoDirAt(settings, video, where) } : null;
  }
  const nDir = notesDir(settings, video);
  const cDir = chatsDir(settings, video);
  const [noteFiles, chatFiles] = await Promise.all([listMd(settings, nDir), listMd(settings, cDir)]);
  if (video.hubFile && video.hubFile !== hubPath(settings, video)) video.hubFile = null; // folder moved
  // Hub note tags win when the key is there (edited in Obsidian); a hub without the key keeps local tags.
  const hub = await io(settings, { op: 'read', path: hubPath(settings, video) });
  if (hub.content != null) {
    const { meta, raw } = parseFrontmatter(hub.content);
    const t = tagsOf(meta, raw);
    if (t) video.tags = t;
  }
  const summary = videoFolder(video);

  // notes
  const cards = [];
  const byFile = new Map(video.notes.cards.filter((c) => c.file).map((c) => [c.file, c]));
  const byId = new Map(video.notes.cards.map((c) => [c.id, c]));
  for (const name of noteFiles) {
    if (name === summary) continue; // the pin summary lives in the video folder, not notes/, but be safe
    const { content, mtime } = await io(settings, { op: 'read', path: join(nDir, `${name}.md`) });
    if (content == null) continue;
    const parsed = parseNote(content);
    // Identity = the uuid in front matter (survives renames in Obsidian); file name is the fallback.
    const prev = (parsed.id && byId.get(parsed.id)) || byFile.get(name);
    const card = { id: parsed.id || prev?.id || crypto.randomUUID(), title: '', start: null, color: 0, ts: Date.now(), ...prev, ...parsed, file: name, mtime: mtime || null };
    if (card.kind === 'note') card.title = name; // filename is the title: renames in Obsidian stick
    card.tags = ownTags(video, card.tags); // inherited video tags are not the note's own
    cards.push(card);
  }
  cards.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const fresh = video.notes.cards.filter((c) => !c.file);
  video.notes.cards = [...cards, ...fresh];
  for (const c of fresh) await syncNote(settings, video, c);

  // chats
  const chats = [];
  const chatByFile = new Map(video.chats.filter((c) => c.file).map((c) => [c.file, c]));
  const chatById = new Map(video.chats.map((c) => [c.id, c]));
  for (const name of chatFiles) {
    const { content, mtime } = await io(settings, { op: 'read', path: join(cDir, `${name}.md`) });
    if (content == null) continue;
    const parsed = parseChat(content);
    const prev = (parsed.id && chatById.get(parsed.id)) || chatByFile.get(name);
    chats.push({
      id: parsed.id || prev?.id || crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...prev,
      ...parsed,
      title: name, // filename is the title: renames in Obsidian stick
      file: name,
      mtime: mtime || null,
    });
    chats.at(-1).tags = ownTags(video, chats.at(-1).tags);
  }
  chats.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const freshChats = video.chats.filter((c) => !c.file && c.messages.length);
  video.chats = [...chats, ...freshChats];
  for (const c of freshChats) await syncChat(settings, video, c);
  if (!video.chats.some((c) => c.id === video.activeChatId)) video.activeChatId = video.chats.at(-1)?.id ?? null;
}
