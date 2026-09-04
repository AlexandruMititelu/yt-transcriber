// Smoke: build every view against the DOM stand-in (tests/dom.js). Catches use-before-declaration, missing
// imports and undefined calls at construction time, the class of bug node --check cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom.js';

const { document, window } = installDom();
const store = new Map();
globalThis.browser = {
  storage: { local: {
    async get(key) { if (key === null) return Object.fromEntries(store); if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)])); return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    async remove(k) { store.delete(k); },
  } },
  runtime: { sendMessage: async () => ({ ok: false, error: 'unmocked' }), connect: () => ({ postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }), getURL: (p) => `moz-extension://x/${p}` },
};
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
process.on('unhandledRejection', (e) => errors.push(`unhandled: ${e?.stack || e}`));

const db = await import('../src/lib/db.js');
const video = db.blankVideo('v1', 'Smoke video', 'Chan');
video.transcript = {
  lang: 'en', trackName: 'English', duration: 60, chapters: [{ start: 0, title: 'Intro' }],
  grouped: [{ start: 0, end: 20, text: 'hello there', cues: [{ start: 0, text: 'hello' }, { start: 10, text: 'there' }] }],
};
video.chats = [{ id: 'c1', title: 'First chat', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'hi', ts: 1 }, { role: 'assistant', content: 'yo [0:10]', ts: 2, usage: { in: 10, out: 2, cacheRead: 0 }, model: 'claude-sonnet-5' }] }];
video.activeChatId = 'c1';
video.notes.cards = [{ id: 'n1', kind: 'quick', title: '', text: 'quick #idea', start: 5, color: 1, ts: 1 }, { id: 'n2', kind: 'note', title: 'Long', text: '# H\n\nbody ![[attachments/0-05.jpg]]', start: null, color: 0, ts: 2 }];
video.tags = ['ml'];
await db.saveVideo(video);
await db.saveSettings({ anthropicKey: 'k', model: 'anthropic:claude-sonnet-5' });

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const noErrors = (label) => assert.deepEqual(errors.splice(0), [], label);

test('shared views build: chat, notes, tags, quote menu, chat bar, picker, markdown', async () => {
  const { renderMarkdown } = await import('../src/ui/markdown.js');
  const md = renderMarkdown('see [[chats/x|Chat]] and ![[attachments/a.jpg]] at [1:02] #tag', { onSeek() {}, onWiki() {}, onEmbed: async () => null });
  assert.ok(md && md.className === 'ytx-md'); // the stub's innerHTML drops tags, so only the build is checked here
  const { createChatView } = await import('../src/ui/chat.js');
  const chat = createChatView({ video, save: async () => {}, disk: async () => {}, renderMd: (t) => renderMarkdown(t), toast() {}, isLive: () => true, segments: () => video.transcript.grouped, onFrame: async () => null, onNote() {} });
  chat.refresh(); chat.openChats(); chat.focus();
  const { createNotesView } = await import('../src/ui/notes.js');
  const notes = createNotesView({ video, fmtTime: (s) => `${s}`, renderMd: (t) => renderMarkdown(t), currentTime: () => 3, transcriptAt: () => null, onChange() {}, onDelete() {}, onFrame: async () => null });
  notes.select('n1'); notes.toggle(); notes.toggle(); notes.move(1); notes.toggle(); notes.setMode('view'); notes.setMode('edit'); notes.toggle(); notes.focusDelete(); notes.focusDelete(); notes.focusTags(); notes.addNote('quick', 'x'); notes.addNote('note', 'y'); notes.toggle();
  const { createTagEditor, tagChip } = await import('../src/ui/tags.js');
  let tags = ['a'];
  const ed = createTagEditor({ compact: true, get: () => tags, set: (t) => { tags = t; ed.refresh(); }, suggest: () => ['a', 'b'], locked: () => ['ml'] });
  document.body.append(ed.root); ed.root.querySelector('.ytx-tags-plus').click(); ed.refresh(); ed.close();
  const full = createTagEditor({ get: () => tags, set: (t) => { tags = t; }, suggest: () => ['b'] });
  full.refresh(); tagChip('z', { onClick() {} });
  const { attachQuoteMenu } = await import('../src/ui/quote.js');
  attachQuoteMenu(document.body, { source: () => null, toast() {} });
  const { createChatBar, confirmBox } = await import('../src/ui/chatbar.js');
  const bar = createChatBar({ chats: () => video.chats, activeId: () => 'c1', onSelect() {}, onNew() {}, onRename() {}, onDelete() {} });
  bar.open(); bar.open(); confirmBox({ text: 'x', onConfirm() {}, onCancel() {} });
  const { createPicker } = await import('../src/ui/picker.js');
  createPicker({ isLive: () => true, onChange() {} });
  await tick();
  noErrors('shared views');
});

test('library page routes build: detail (all panes), library (all + archive), settings', async () => {
  const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  window.location.hash = '#/video/v1';
  await import('../page/app.js');
  await tick(80);
  assert.ok(!app.textContent.includes('Error:'), app.textContent.slice(0, 200));
  for (const name of ['Chat', 'Notes', 'Transcript']) { for (const b of app.querySelectorAll('.seg-btn')) if (b.textContent === name) b.click(); }
  await tick();
  window.location.hash = '#/';
  window.dispatchEvent(new Event('hashchange'));
  await tick(80);
  assert.ok(app.querySelector('.card-wrap'), 'a card rendered');
  for (const b of app.querySelectorAll('.lib-seg .seg-btn')) if (b.textContent === 'Archive') b.click();
  await tick(80);
  for (const b of app.querySelectorAll('.lib-seg .seg-btn')) if (b.textContent === 'All') b.click();
  await tick(80);
  window.location.hash = '#/settings';
  window.dispatchEvent(new Event('hashchange'));
  await tick(80);
  assert.ok(!app.textContent.includes('Error:'), app.textContent.slice(0, 200));
  noErrors('library page');
});

test.after(() => { console.error = origError; });
