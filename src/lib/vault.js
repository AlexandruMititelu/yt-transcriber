// Knowledge-base folder (Obsidian vault) mirror. Disk is the source of truth when settings.vaultDir is set:
//   <vaultDir>/YT-transcriber/<video>/notes/<note>.md  one file per card (quick note or note)
//   <vaultDir>/YT-transcriber/<video>/chats/<chat>.md  one file per chat
//   <vaultDir>/YT-transcriber/pinned/<video>/...       the same tree, moved here while the video is pinned,
//                                                      plus <video>/<video>.md (title, url, transcript)
// Pure builders/parsers are exported for tests; async ops go through the native host (bus.native).

import { native } from './bus.js';
import { fmtTime } from './format.js';

export const ROOT_NAME = 'YT-transcriber';
export const PINNED_DIR = 'pinned';

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

export function frontmatter(meta) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : yamlStr(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// Minimal front matter reader: `key: value` lines, JSON/quoted strings unwrapped. → { meta, body }
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    meta[k] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

export function noteToMd(video, card) {
  return frontmatter({
    ytx: 'note',
    kind: card.kind === 'note' ? 'note' : 'quick',
    title: card.kind === 'note' ? card.title : undefined,
    video: video.url,
    time: card.start == null ? undefined : fmtTime(card.start),
    start: card.start == null ? undefined : Math.floor(card.start),
    color: card.color || 0,
    created: iso(card.ts),
  }) + (card.text || '');
}

// → partial card {text, kind, title?, start?, color?, ts?}. Files without our front matter (written by
// hand in Obsidian) are long-form notes; legacy ytx files without `kind` are quick notes.
export function parseNote(md) {
  const { meta, body } = parseFrontmatter(md);
  const out = { text: body.replace(/\s+$/, '') };
  if (meta.ytx !== 'note') { out.kind = 'note'; return out; }
  out.kind = meta.kind === 'note' ? 'note' : 'quick';
  if (meta.title) out.title = String(meta.title);
  if (typeof meta.start === 'number') out.start = meta.start;
  else out.start = null;
  if (typeof meta.color === 'number') out.color = meta.color;
  if (meta.created) { const t = parseStamp(meta.created); if (t) out.ts = t; }
  return out;
}

// Chat body = one Obsidian callout per message: `> [!user] 2026-09-04 13:31:26` then `> `-prefixed
// content. Readable in Obsidian, still parseable: a message ends at the first non-quoted line.
// Header = exactly `> [!role]` plus an optional stamp; anything else after the tag is content.
const CALLOUT = /^> \[!(user|assistant)\](?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?$/;
// Legacy (v1 files): `<!-- ytx:user ts=123 -->` markers with `### You|Assistant` headings.
const MSG_MARK = /^<!-- ytx:(user|assistant) ts=(\d+) -->[ \t]*\r?\n(?:### (?:You|Assistant)[ \t]*\r?\n)?/gm;

export function chatToMd(video, chat) {
  const head = frontmatter({
    ytx: 'chat',
    title: chat.title,
    video: video.url,
    created: iso(chat.createdAt),
    updated: iso(chat.updatedAt),
  });
  const body = chat.messages.map((m) => {
    const lines = String(m.content).replace(/\s+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>'));
    return `> [!${m.role}] ${localStamp(m.ts)}\n${lines.join('\n')}\n`;
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
      cur = { role: head[1], ts: parseStamp(head[2]), lines: [] };
      messages.push(cur);
    } else if (cur && line.startsWith('>')) {
      cur.lines.push(line.replace(/^> ?/, ''));
    } else {
      cur = null; // first non-quoted line closes the callout
    }
  }
  return messages.map(({ role, ts, lines }) => ({ role, ts, content: lines.join('\n').replace(/\s+$/, '') }));
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
  const { meta, body } = parseFrontmatter(md);
  let messages = parseCallouts(body);
  if (!messages.length) messages = parseMarkers(body);
  const out = { messages };
  if (meta.title) out.title = String(meta.title);
  for (const [k, f] of [['created', 'createdAt'], ['updated', 'updatedAt']]) {
    const t = meta[k] ? parseStamp(meta[k]) : 0;
    if (t) out[f] = t;
  }
  return out;
}

export function pinToMd(video) {
  const head = frontmatter({
    ytx: 'video',
    id: video.videoId,
    url: video.url,
    channel: video.channel,
    pinned: iso(Date.now()),
  });
  const lines = [`# ${video.title || video.videoId}`, '', `[Watch on YouTube](${video.url})`];
  if (video.channel) lines.push(`Channel: ${video.channel}`);
  const grouped = video.transcript?.grouped ?? [];
  if (grouped.length) {
    lines.push('', '## Transcript', '');
    for (const s of grouped) lines.push(`- [${fmtTime(s.start)}](${video.url}&t=${Math.floor(s.start)}s) ${s.text}`);
  }
  return head + lines.join('\n') + '\n';
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
const videoDirAt = (settings, video, pinned) =>
  pinned ? join(rootDir(settings), PINNED_DIR, videoFolder(video)) : join(rootDir(settings), videoFolder(video));
export const videoDir = (settings, video) => videoDirAt(settings, video, !!video.pinned);
const notesDir = (settings, video) => join(videoDir(settings, video), 'notes');
const chatsDir = (settings, video) => join(videoDir(settings, video), 'chats');
const summaryPath = (settings, video) => join(videoDir(settings, video), `${videoFolder(video)}.md`);

/* ---------- async ops (native host) ---------- */

export const ping = () => native({ op: 'ping' });
export const pickFolder = async () => (await native({ op: 'pick-folder' })).path;

async function listMd(dir) {
  const { entries } = await native({ op: 'list', path: dir });
  return entries.filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3));
}

// Both subfolders exist as soon as the video has anything on disk, so notes can be written
// offline in Obsidian and picked up next time.
async function ensureDirs(settings, video) {
  await native({ op: 'mkdir', path: notesDir(settings, video) });
  await native({ op: 'mkdir', path: chatsDir(settings, video) });
  await syncTranscript(settings, video);
}

export function transcriptToMd(video) {
  const grouped = video.transcript?.grouped ?? [];
  const lines = grouped.map((s) => `- [${fmtTime(s.start)}](${video.url}&t=${Math.floor(s.start)}s) ${s.text}`);
  return frontmatter({ ytx: 'transcript', id: video.videoId, url: video.url, lang: video.transcript?.lang }) +
    `# ${video.title || video.videoId}\n\n${lines.join('\n')}\n`;
}

// <video>/Transcript.md, written once the transcript exists (video.transcriptFile remembers the location).
export async function syncTranscript(settings, video) {
  if (!enabled(settings) || !video.transcript?.grouped?.length) return;
  const path = join(videoDir(settings, video), 'Transcript.md');
  if (video.transcriptFile === path) return;
  await native({ op: 'write', path, content: transcriptToMd(video) });
  video.transcriptFile = path;
}

// Write (or rename+write) one file under `dir`; `owner.file` is the disk key.
async function put(dir, owner, name, content) {
  if (owner.file && owner.file !== name) {
    await native({ op: 'rename', from: join(dir, `${owner.file}.md`), to: join(dir, `${name}.md`) });
  }
  await native({ op: 'write', path: join(dir, `${name}.md`), content });
  owner.file = name;
}

async function drop(dir, owner) {
  if (!owner.file) return;
  await native({ op: 'delete', path: join(dir, `${owner.file}.md`) });
  owner.file = null;
}

const takenExcept = (items, me) => new Set(items.filter((x) => x !== me && x.file).map((x) => x.file));

export async function syncNote(settings, video, card) {
  if (!enabled(settings)) return;
  if (!card.file && !(card.text || '').trim() && !(card.title || '').trim()) return; // don't create files for blank cards
  await ensureDirs(settings, video);
  await put(notesDir(settings, video), card, noteName(card, takenExcept(video.notes.cards, card)), noteToMd(video, card));
}

export async function removeNote(settings, video, card) {
  if (enabled(settings)) await drop(notesDir(settings, video), card);
}

export async function syncChat(settings, video, chat) {
  if (!enabled(settings)) return;
  if (!chat.file && !chat.messages.length) return;
  await ensureDirs(settings, video);
  await put(chatsDir(settings, video), chat, chatName(chat, takenExcept(video.chats, chat)), chatToMd(video, chat));
}

export async function removeChat(settings, video, chat) {
  if (enabled(settings)) await drop(chatsDir(settings, video), chat);
}

async function dirExists(dir) {
  const { entries } = await native({ op: 'list', path: dir });
  return entries.length > 0;
}

// Pin = move the whole video folder under pinned/ and drop a summary .md inside it. Unpin moves it back.
export async function pin(settings, video) {
  if (!enabled(settings)) throw new Error('no-vault');
  const from = videoDirAt(settings, video, false);
  const to = videoDirAt(settings, video, true);
  if (await dirExists(from)) await native({ op: 'rename', from, to });
  video.pinned = { at: Date.now(), dir: to };
  video.transcriptFile = null; // moved with the folder; re-stamp under the new path
  await ensureDirs(settings, video);
  await native({ op: 'write', path: summaryPath(settings, video), content: pinToMd(video) });
  return to;
}

export async function unpin(settings, video) {
  if (!enabled(settings)) throw new Error('no-vault');
  const from = videoDirAt(settings, video, true);
  const to = videoDirAt(settings, video, false);
  await native({ op: 'delete', path: join(from, `${videoFolder(video)}.md`) });
  if (await dirExists(from)) await native({ op: 'rename', from, to });
  video.pinned = null;
  video.transcriptFile = null;
  return to;
}

// Disk → record. Files win for anything that has a file; local items without a file get written
// (first run after enabling the vault). Mutates `video`; caller saves. Throws if the host is missing.
export async function hydrate(settings, video) {
  if (!enabled(settings)) return;
  if (!video.folder && !hasTitle(video)) return; // nothing on disk can belong to a video we can't name yet
  // Where the folder actually lives decides pinned state (moving it in Obsidian pins/unpins).
  const inPinned = await dirExists(videoDirAt(settings, video, true));
  if (inPinned && !video.pinned) video.pinned = { at: Date.now(), dir: videoDirAt(settings, video, true) };
  else if (!inPinned && video.pinned && (await dirExists(videoDirAt(settings, video, false)))) video.pinned = null;
  const nDir = notesDir(settings, video);
  const cDir = chatsDir(settings, video);
  const [noteFiles, chatFiles] = await Promise.all([listMd(nDir), listMd(cDir)]);
  const summary = videoFolder(video);

  // notes
  const cards = [];
  const byFile = new Map(video.notes.cards.filter((c) => c.file).map((c) => [c.file, c]));
  for (const name of noteFiles) {
    if (name === summary) continue; // the pin summary lives in the video folder, not notes/, but be safe
    const { content } = await native({ op: 'read', path: join(nDir, `${name}.md`) });
    if (content == null) continue;
    const parsed = parseNote(content);
    const prev = byFile.get(name);
    const card = { id: prev?.id ?? crypto.randomUUID(), title: '', start: null, color: 0, ts: Date.now(), ...prev, ...parsed, file: name };
    if (card.kind === 'note') card.title = name; // filename is the title: renames in Obsidian stick
    cards.push(card);
  }
  cards.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const fresh = video.notes.cards.filter((c) => !c.file);
  video.notes.cards = [...cards, ...fresh];
  for (const c of fresh) await syncNote(settings, video, c);

  // chats
  const chats = [];
  const chatByFile = new Map(video.chats.filter((c) => c.file).map((c) => [c.file, c]));
  for (const name of chatFiles) {
    const { content } = await native({ op: 'read', path: join(cDir, `${name}.md`) });
    if (content == null) continue;
    const parsed = parseChat(content);
    const prev = chatByFile.get(name);
    chats.push({
      id: prev?.id ?? crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...prev,
      ...parsed,
      title: name, // filename is the title: renames in Obsidian stick
      file: name,
    });
  }
  chats.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const freshChats = video.chats.filter((c) => !c.file && c.messages.length);
  video.chats = [...chats, ...freshChats];
  for (const c of freshChats) await syncChat(settings, video, c);
  if (!video.chats.some((c) => c.id === video.activeChatId)) video.activeChatId = video.chats.at(-1)?.id ?? null;
}
