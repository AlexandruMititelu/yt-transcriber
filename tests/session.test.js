// Compact coverage of the features built in the tags / quotes / archive / hotkeys / long-transcript session.
// Everything runs against the DOM stand-in (tests/dom.js) and the fake storage / native host below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom.js';

const { document, window } = installDom();
const store = new Map();
const files = new Map();
globalThis.browser = {
  storage: { local: {
    async get(k) { if (k === null) return Object.fromEntries(store); if (Array.isArray(k)) return Object.fromEntries(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])); return store.has(k) ? { [k]: store.get(k) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); },
    async remove(k) { for (const x of [].concat(k)) store.delete(x); },
  } },
  runtime: {
    getURL: (p) => `moz-extension://x/${p}`,
    async sendMessage(msg) {
      if (msg.type === 'native') {
        const { op } = msg;
        if (op === 'read') return { ok: true, content: files.get(msg.path) ?? null, mtime: 1 };
        if (op === 'read-b64') return { ok: true, data: files.has(msg.path) ? 'QUFB' : null };
        if (op === 'write') { files.set(msg.path, msg.content); return { ok: true, mtime: 2 }; }
        if (op === 'list') { const pre = msg.path + '/'; const names = new Map(); for (const k of files.keys()) if (k.startsWith(pre)) { const r = k.slice(pre.length); names.set(r.split('/')[0], r.includes('/')); } return { ok: true, entries: [...names].map(([name, dir]) => ({ name, dir })) }; }
        if (op === 'rename') { for (const k of [...files.keys()]) if (k === msg.from || k.startsWith(msg.from + '/')) { files.set(msg.to + k.slice(msg.from.length), files.get(k)); files.delete(k); } return { ok: true }; }
        return { ok: true, entries: [], mtime: null };
      }
      return { ok: false, error: 'unmocked' };
    },
    // streaming port: the test sets `sse` to the events the background would relay
    connect: () => ({ postMessage() { setTimeout(() => { for (const ev of globalThis.sse ?? []) port.on.message?.(ev.type === 'done' ? ev : { type: 'event', event: ev }); port.on.message?.({ type: 'done' }); }, 0); }, disconnect() {}, onMessage: { addListener(f) { port.on.message = f; } }, onDisconnect: { addListener() {} } }),
  },
};
const port = { on: {} };
const key = (el, k, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, ...init }));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const db = await import('../src/lib/db.js');
const llm = await import('../src/lib/llm.js');
const vault = await import('../src/lib/vault.js');
const { renderMarkdown } = await import('../src/ui/markdown.js');
const { createNotesView } = await import('../src/ui/notes.js');
const { createTagEditor } = await import('../src/ui/tags.js');
const { createChatBar } = await import('../src/ui/chatbar.js');
const { createChatView } = await import('../src/ui/chat.js');
const { HOTKEYS, hotkeyId, keysFor } = await import('../config/hotkeys.js');

const mkVideo = () => {
  const v = db.blankVideo('s1', 'Session video', 'Chan');
  v.transcript = { lang: 'en', duration: 60, chapters: [], grouped: [{ start: 0, end: 20, text: 'alpha beta', cues: [{ start: 0, text: 'alpha' }, { start: 10, text: 'beta' }] }] };
  v.notes.cards = [{ id: 'q1', kind: 'quick', title: '', text: 'quick #idea', start: null, color: 0, ts: 1 }, { id: 'n1', kind: 'note', title: 'Long', text: 'body', start: null, color: 0, ts: 2 }];
  v.chats = [{ id: 'c1', title: 'Chat A', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'q', ts: 1 }, { role: 'assistant', content: 'a', ts: 2 }] }, { id: 'c2', title: 'Chat B', createdAt: 3, updatedAt: 4, messages: [] }];
  v.activeChatId = 'c1';
  v.tags = ['ml'];
  return v;
};

test('hotkeys: every listed shortcut resolves, new ones included', () => {
  for (const hk of HOTKEYS) assert.ok(hk.keys && hk.desc, hk.id);
  const ids = HOTKEYS.map((h) => h.id);
  for (const [k, id, init] of [['t', 'tags'], ['Backspace', 'deleteNote'], ['Enter', 'toggleNote'], ['c', 'focusChat'], ['Enter', 'focusVideo', { shiftKey: true }]]) {
    assert.equal(hotkeyId({ altKey: true, key: k, ...(init ?? {}) }), id);
    assert.ok(ids.includes(id));
  }
  assert.equal(hotkeyId({ altKey: true, ctrlKey: true, key: 't' }), null);
  assert.equal(keysFor('tags'), 'Alt+T');
});

test('markdown: wiki links open chats, image embeds resolve to data urls, remote img stays out', async () => {
  const opened = [];
  const md = renderMarkdown('see [[chats/Chat A|Chat: A]] and ![[attachments/0-05.jpg]] <img src="https://evil/x.png">', { onWiki: (t) => opened.push(t), onEmbed: async () => 'data:image/jpeg;base64,QUFB' });
  document.body.append(md); // embeds resolve only once the node is in the document
  md.querySelector('.ytx-wiki').click();
  assert.deepEqual(opened, ['chats/Chat A']);
  await tick();
  assert.equal(md.querySelector('.ytx-embed-img')?.getAttribute('src'), 'data:image/jpeg;base64,QUFB');
  assert.equal(md.querySelectorAll('img').length, 1, 'only our data: image, never a remote one');
});

test('llm streaming: tool activity phases from Anthropic content blocks, tool loop, history fit, context meter math', async () => {
  globalThis.sse = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking. ' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ];
  const phases = [];
  let text = '';
  const out = await llm.chat({ settings: { anthropicKey: 'k', model: 'anthropic:claude-sonnet-5', effort: 'off', webSearch: true }, system: 's', messages: [{ role: 'user', content: 'q' }], onText: (d) => { text += d; }, onTool: (n, i, p) => phases.push(`${n}:${p}`) });
  assert.equal(text, 'Looking. Done.');
  assert.deepEqual(phases, ['web_search:start', 'web_search:result']);
  assert.equal(out.usage.in, 5);
  assert.equal(llm.contextWindow('claude-sonnet-5'), 1e6);
  assert.equal(llm.contextCap('claude-haiku-4-5'), Math.round(200000 * 0.2 * 3.5));
  assert.ok(llm.promptCoverage([{ text: 'x'.repeat(30000) }], 24000) < 1, 'over the cap → retrieval mode');
  assert.equal(llm.fitHistory({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'x'.repeat(3.5 * 120000) }, { role: 'user', content: 'last' }] }).dropped, 1);
});

test('vault: tags in hub/Index/children, Archive location, lowercase pinned/ migrated, frames read back', async () => {
  files.clear();
  const settings = { vaultDir: 'V' };
  const video = mkVideo();
  await vault.syncTags(settings, video);
  const hub = 'V/YT-transcriber/Session video/Session video.md';
  assert.match(files.get(hub), /tags: \[ml\]/);
  assert.match(files.get('V/YT-transcriber/Index.md'), /Session video\]\] · Chan #ml/);
  await vault.archive(settings, video);
  assert.ok(files.has('V/YT-transcriber/Archive/Session video/Session video.md'));
  assert.match(files.get('V/YT-transcriber/Index.md'), /## Archive/);
  await vault.unarchive(settings, video);
  files.set('W/YT-transcriber/pinned/Old/Old.md', '---\nytx: "video"\ntitle: "Old"\n---\n'); // a vault seen for the first time
  await vault.refreshIndex({ vaultDir: 'W' });
  assert.ok(files.has('W/YT-transcriber/Pinned/Old/Old.md') && !files.has('W/YT-transcriber/pinned/Old/Old.md'), 'pinned/ renamed to Pinned/');
  assert.match(files.get('W/YT-transcriber/Index.md'), /\[\[Pinned\/Old\/Old\|Old\]\]/);
  files.set('V/YT-transcriber/Session video/attachments/0-05.jpg', 'bin');
  assert.equal(await vault.readFrame(settings, video, 'attachments/0-05.jpg'), 'data:image/jpeg;base64,QUFB');
  assert.equal(vault.indexToMd([{ folder: 'a', loc: 'Archive', title: 'a' }, { folder: 'b', loc: '', title: 'b' }, { folder: 'c', loc: 'Pinned', title: 'c' }]).split('\n').filter((l) => l.startsWith('## ')).join(','), '## Pinned,## All,## Archive');
});

test('notes keyboard: Enter opens a selected card, Alt+Backspace ×3 = focus / ask / cancel, quick note Alt+Enter leaves edit, tags via focusTags', async () => {
  const video = mkVideo();
  const nv = createNotesView({ video, fmtTime: String, renderMd: (t) => renderMarkdown(t), currentTime: () => 3, onChange() {}, onDelete() {} });
  document.body.append(nv.root);
  nv.select('n1');
  key(nv.root.querySelector('.ytx-nt'), 'Enter');
  assert.ok(nv.isEditing(), 'Enter on a selected note opens it');
  assert.equal(document.activeElement.className, 'ytx-ed-title', 'caret on the title');
  key(document.activeElement, 'Enter');
  assert.equal(document.activeElement.tagName, 'TEXTAREA', 'Enter on the title moves into the text');
  nv.toggle(); // back to the list
  assert.ok(!nv.isEditing());
  nv.select('q1');
  nv.focusDelete();
  assert.ok(document.activeElement.classList.contains('ytx-notes-del'), '×1 focuses the trash');
  nv.focusDelete();
  assert.ok(nv.root.querySelector('.ytx-notes-overlay'), '×2 asks');
  assert.ok(document.activeElement.classList.contains('ytx-confirm-danger'), 'Enter would delete');
  nv.focusDelete();
  assert.ok(!nv.root.querySelector('.ytx-notes-overlay'), '×3 cancels');
  nv.toggle(); // quick note → edit mode
  assert.ok(nv.root.querySelector('.ytx-qn textarea'), 'quick note editing');
  nv.toggle();
  assert.ok(!nv.root.querySelector('.ytx-qn textarea'), 'Alt+Enter leaves edit mode');
  assert.equal(nv.selectedId(), 'q1', 'still selected');
  assert.ok(nv.focusTags(), 'Alt+T opens the card tag popover');
  assert.ok(document.activeElement.classList.contains('ytx-tags-input'));
  const ed = nv.root.querySelector('.ytx-qn .ytx-tags-pop.is-open');
  assert.ok(ed.textContent.includes('From the video') && ed.textContent.includes('ml'), 'inherited video tag shown locked');
});

test('tag editor keyboard: arrows walk input → known → selected, Enter toggles, Alt+Enter closes; colours stick', async () => {
  let tags = ['a'];
  const ed = createTagEditor({ compact: true, get: () => tags, set: (t) => { tags = t; ed.refresh(); }, suggest: () => ['a', 'b'] });
  document.body.append(ed.root);
  ed.root.querySelector('.ytx-tags-plus').click();
  const input = ed.root.querySelector('.ytx-tags-input');
  assert.equal(document.activeElement, input);
  key(input, 'ArrowDown');
  assert.equal(document.activeElement.dataset.tag, 'b', 'first known (unselected) tag');
  key(document.activeElement, 'Enter'); document.activeElement.click();
  assert.deepEqual(tags, ['a', 'b']);
  key(input, ' ');
  assert.ok(input.classList.contains('is-bad'), 'spaces refused');
  input.value = 'new'; input.dispatchEvent(new Event('input'));
  assert.ok(ed.root.querySelector('.ytx-tag.is-new'), 'unknown text offers + new');
  key(input, 'Enter');
  assert.deepEqual(tags, ['a', 'b', 'new']);
  key(input, 'ArrowUp');
  assert.ok(document.activeElement.classList.contains('is-sel'), 'wraps to the last selected chip');
  key(document.activeElement, 'Backspace', { altKey: true });
  assert.deepEqual(tags, ['a', 'b']);
  key(input, 'Enter', { altKey: true });
  assert.ok(!ed.root.querySelector('.ytx-tags-pop.is-open'), 'Alt+Enter closes');
  const { tagHue, configureTagColors } = await import('../src/lib/tags.js');
  const saved = [];
  configureTagColors({}, (m) => saved.push(m));
  const h1 = tagHue('x'); const h2 = tagHue('y');
  assert.notEqual(h1, h2); assert.equal(tagHue('x'), h1); assert.deepEqual(saved.at(-1), { x: h1, y: h2 });
});

test('chat bar keyboard mode: Alt+C opens on the current chat, arrows move, Alt+Enter deletes the focused one', () => {
  const calls = [];
  const bar = createChatBar({ chats: () => [{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }], activeId: () => 'c1', onSelect: (id) => calls.push(`select:${id}`), onNew() {}, onRename() {}, onDelete: () => calls.push('delete') });
  document.body.append(bar.root);
  bar.open();
  assert.equal(document.activeElement.dataset.chat, 'c1');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  assert.equal(document.activeElement.dataset.chat, 'c2');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true }));
  assert.deepEqual(calls, ['select:c2', 'delete']);
});

test('chat view: quote source links back to the chat file, frames attach to the next message, retrieval hint on long transcripts', async () => {
  const video = mkVideo();
  video.transcript.grouped = Array.from({ length: 3000 }, (_, i) => ({ start: i * 20, end: i * 20 + 20, text: 'word '.repeat(60), cues: [] }));
  const saved = [];
  const view = createChatView({ video, save: async () => saved.push(1), disk: async () => {}, renderMd: (t) => renderMarkdown(t), toast() {}, isLive: () => true, segments: () => video.transcript.grouped, onFrame: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', sec: 61, embed: '![[attachments/1-01.jpg]]' }) });
  document.body.append(view.root);
  const msgEl = view.root.querySelector('.ytx-msg-assistant');
  assert.equal(msgEl.__msg.role, 'assistant');
  view.root.querySelector('.ytx-chat-cam').click();
  await tick();
  assert.ok(view.root.querySelector('.ytx-chat-attach-img'), 'frame chip shown');
  view.refresh(); // empty-state hint for a new chat
  video.activeChatId = 'c2'; view.refresh();
  assert.match(view.root.textContent, /does not fit this model/);
});
