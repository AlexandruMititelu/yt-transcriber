// Memory: durable facts about the user, learned across chats and injected into every chat system prompt.
// One file, kept small on purpose so it never crowds the context window:
//   <vault>/YT-transcriber/admin/Memory.md   (source of truth when a vault is set; edit it in Obsidian too)
//   settings.memoryText                       (mirror, and the only copy without a vault)
// Written three ways: the model's remember/forget tools, a cheap consolidation call every few chat turns,
// and the textarea in Settings. settings.memory=false turns injection, tools and consolidation off.
import * as db from './db.js';
import * as vault from './vault.js';
import * as llm from './llm.js';

export const FILE = 'Memory.md';
export const MAX_CHARS = 1200; // ~350 tokens. Hard ceiling; the consolidation prompt aims below it.
export const MAX_LINES = 12;
const CHEAP = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-5-mini' };
const EVERY = 4; // messages (user+assistant) between consolidations of one chat

/* ---------- pure ---------- */

const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const bullet = (l) => (l.startsWith('- ') ? l : `- ${l.replace(/^[-*•]\s*/, '')}`);
const norm = (l) => l.replace(/^[-*•]\s*/, '').toLowerCase().replace(/\s+/g, ' ').replace(/[.。]$/, '');

// Whole bullets only, newest first, capped by lines and characters.
export function clip(text) {
  const out = [];
  let n = 0;
  for (const l of lines(text).map(bullet)) {
    if (out.length >= MAX_LINES || n + l.length + 1 > MAX_CHARS) break;
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n');
}

// Prepend a fact (newest first survives clipping), dropping an existing line that says the same thing.
export function addFact(text, fact) {
  const f = bullet(String(fact ?? '').trim().replace(/\s+/g, ' '));
  if (f === '- ') return clip(text);
  return clip([f, ...lines(text).filter((l) => norm(l) !== norm(f))].join('\n'));
}

// Remove every line containing all the given words (case-insensitive). → { text, removed }
export function dropFacts(text, words) {
  const ws = String(words ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return { text: clip(text), removed: 0 };
  const keep = lines(text).filter((l) => !ws.every((w) => l.toLowerCase().includes(w)));
  return { text: clip(keep.join('\n')), removed: lines(text).length - keep.length };
}

/* ---------- storage ---------- */

// Raw contents regardless of the on/off switch (Settings shows it either way).
export async function load(settings) {
  if (vault.enabled(settings)) {
    const c = await vault.readAdmin(settings, FILE).catch(() => null);
    if (c != null) return clip(c);
  }
  return clip(settings.memoryText || '');
}

export async function save(settings, text) {
  const t = clip(text);
  if (vault.enabled(settings)) await vault.writeAdmin(settings, FILE, t ? `${t}\n` : '');
  await db.saveSettings({ memoryText: t });
  return t;
}

// What goes into the system prompt: '' when memory is off.
export const forPrompt = (settings) => (settings.memory === false ? Promise.resolve('') : load(settings));

/* ---------- model tools ---------- */

// { defs, run } in the shape llm.chat expects; null when memory is off.
export function tools(settings) {
  if (settings.memory === false) return null;
  const defs = [
    {
      name: 'remember',
      description: 'Save one durable fact about the user for future chats: background, expertise, preferences about answers, goals, ongoing projects, recurring interests. Use it when the user asks you to remember something or states something clearly lasting about themselves. Never store video content or anything the user could re-read in the video. One short sentence.',
      input_schema: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, one sentence' } }, required: ['fact'] },
    },
    {
      name: 'forget',
      description: 'Remove remembered facts that contain all the given words. Use it when the user asks you to forget something.',
      input_schema: { type: 'object', properties: { words: { type: 'string', description: 'Words that identify the fact(s) to remove' } }, required: ['words'] },
    },
  ];
  const run = async (name, input = {}) => {
    const s = await db.getSettings();
    const cur = await load(s);
    if (name === 'remember') { await save(s, addFact(cur, input.fact)); return 'Saved.'; }
    if (name === 'forget') { const r = await dropFacts(cur, input.words); await save(s, r.text); return r.removed ? `Removed ${r.removed} fact(s).` : 'Nothing matched.'; }
    return `Unknown tool ${name}`;
  };
  return { defs, run };
}

/* ---------- consolidation ---------- */

const PROMPT =
  'You maintain a short memory about one user for an assistant that discusses YouTube videos with them. ' +
  'Given the current memory and a recent chat, output the updated memory as markdown bullets: ' +
  `at most ${MAX_LINES} bullets, one line each, under ${MAX_CHARS - 200} characters in total. ` +
  'Keep only durable facts about the user: background, expertise, preferences about how answers should look, goals, ongoing projects, recurring interests. ' +
  'Never store video content, summaries, or anything the user could re-read in the video. ' +
  'Merge duplicates, drop facts the chat contradicts, keep wording neutral and specific. ' +
  'Output only the bullets, or the single word UNCHANGED when the chat adds nothing durable.';

// Due every EVERY messages of a chat (chat.memAt = length at the last run). Mutates chat.memAt.
export const due = (settings, chat) => settings.memory !== false && chat.messages.length - (chat.memAt ?? 0) >= EVERY;

// One cheap call on the current provider; returns the new memory text, or null when nothing changed.
export async function consolidate(settings, chat, meta = {}) {
  chat.memAt = chat.messages.length;
  const cur = await load(settings);
  const convo = chat.messages
    .map((m) => `${m.role}: ${String(m.content).slice(0, 1500)}`)
    .join('\n\n')
    .slice(-12000);
  const provider = llm.parseModel(settings.model).provider;
  const r = await llm.chat({
    settings: { ...settings, model: `${provider}:${CHEAP[provider] ?? llm.DEFAULT_MODELS[provider]}`, effort: 'off', webSearch: false },
    system: PROMPT,
    messages: [{ role: 'user', content: `Current memory:\n${cur || '(empty)'}\n\nChat:\n${convo}` }],
    maxTokens: 500,
    meta: { kind: 'memory', ...meta },
  });
  const text = clip(r.text);
  if (/^UNCHANGED\b/i.test(r.text.trim()) || text === cur) return null;
  return save(settings, text);
}
