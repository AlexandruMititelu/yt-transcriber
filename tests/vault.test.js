import test from 'node:test';
import assert from 'node:assert/strict';

// Fake native host: an in-memory filesystem behind browser.runtime.sendMessage.
const files = new Map();
const mtimes = new Map(); // path → fake mtime (bump on every write)
const dirs = new Set();
let clock = 1;
const writeDisk = (p, content) => { files.set(p, content); mtimes.set(p, clock++); }; // "someone edited it in Obsidian"
globalThis.browser = {
  runtime: {
    async sendMessage(msg) {
      if (msg.type !== 'native') return { ok: false, error: 'unexpected' };
      const { op } = msg;
      if (['list', 'read', 'stat', 'write', 'delete', 'rename', 'mkdir'].includes(op) && !msg.root) return { ok: false, error: 'missing root' };
      if (op === 'stat') return { ok: true, mtime: mtimes.get(msg.path) ?? null };
      if (op === 'list') {
        const prefix = msg.path.replace(/\/+$/, '') + '/';
        const names = new Set();
        for (const k of files.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const first = rest.split('/')[0];
          names.add(JSON.stringify({ name: first, dir: rest.includes('/') }));
        }
        return { ok: true, entries: [...names].map((s) => JSON.parse(s)) };
      }
      if (op === 'mkdir') { dirs.add(msg.path); return { ok: true }; }
      if (op === 'read') return { ok: true, content: files.has(msg.path) ? files.get(msg.path) : null, mtime: mtimes.get(msg.path) ?? null };
      if (op === 'write') { writeDisk(msg.path, msg.content); return { ok: true, mtime: mtimes.get(msg.path) }; }
      if (op === 'delete') { files.delete(msg.path); return { ok: true }; }
      if (op === 'rename') {
        if (files.has(msg.from)) { files.set(msg.to, files.get(msg.from)); files.delete(msg.from); return { ok: true }; }
        for (const k of [...files.keys()]) { // directory move
          if (k.startsWith(msg.from + '/')) { files.set(msg.to + k.slice(msg.from.length), files.get(k)); files.delete(k); }
        }
        return { ok: true };
      }
      return { ok: false, error: `unknown op ${op}` };
    },
  },
};

const vault = await import('../src/lib/vault.js');
const db = await import('../src/lib/db.js');
const settings = { vaultDir: 'C:\\Vault\\' };

test('safeName strips reserved chars, collapses whitespace, clamps, falls back', () => {
  assert.equal(vault.safeName('  Hello: <World>?  |  #1 [x]  '), 'Hello World 1 x');
  assert.equal(vault.safeName('...'), 'untitled');
  assert.equal(vault.safeName('', 'fb'), 'fb');
  assert.equal(vault.safeName('a'.repeat(200)).length, 80);
});

test('noteName: quick notes by first line, notes by title, dedupes', () => {
  assert.equal(vault.noteName({ id: 'abcdefgh-1', kind: 'quick', text: '\n\n  Key idea: foo\nmore' }), 'Key idea foo');
  assert.equal(vault.noteName({ id: 'abcdefgh-1', kind: 'quick', text: '' }), 'Note abcdefgh');
  assert.equal(vault.noteName({ id: 'x', kind: 'quick', text: 'Same' }, new Set(['Same', 'Same 2'])), 'Same 3');
  assert.equal(vault.noteName({ id: 'x', kind: 'note', title: 'My: Essay', text: 'body first line' }), 'My Essay');
  assert.equal(vault.noteName({ id: 'x', kind: 'note', title: '', text: 'body first line' }), 'body first line');
});

test('note markdown roundtrips through parseNote', () => {
  const video = { url: 'https://www.youtube.com/watch?v=abc' };
  const card = { id: '1', text: 'First line\n\nbody: with colon\n---\nnot front matter', start: 754.9, color: 3, ts: 1700000000000 };
  const md = vault.noteToMd(video, card);
  assert.ok(md.startsWith('---\nytx: "note"\n'));
  assert.ok(md.includes('time: "12:34"'));
  assert.ok(/created: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/.test(md), 'local readable stamp');
  assert.ok(md.includes('id: "1"'), 'uuid in front matter');
  const back = vault.parseNote(md);
  assert.equal(back.id, '1');
  assert.equal(back.text, card.text);
  assert.equal(back.kind, 'quick');
  assert.equal(back.start, 754);
  assert.equal(back.color, 3);
  assert.equal(back.ts, card.ts);
  const note = vault.parseNote(vault.noteToMd(video, { id: '2', kind: 'note', title: 'Essay', text: '# H\n\nbody', start: null, color: 0, ts: 1 }));
  assert.equal(note.kind, 'note');
  assert.equal(note.title, 'Essay');
  assert.equal(note.text, '# H\n\nbody');
  // plain file written by hand in Obsidian = long-form note
  assert.deepEqual(vault.parseNote('just text\n'), { text: 'just text', kind: 'note', fm: '' });
});

test('chat markdown = Obsidian callouts; roundtrips headings/rules/quotes/blank lines; legacy markers still parse', () => {
  const video = { url: 'https://www.youtube.com/watch?v=abc' };
  const t1 = new Date(2026, 8, 4, 13, 31, 26).getTime();
  const chat = {
    id: 'c1', title: 'Why the sky is blue', createdAt: 1700000000000, updatedAt: 1700000005000,
    messages: [
      { role: 'user', content: 'why blue?', ts: t1 },
      { role: 'assistant', content: '### Rayleigh\n\n---\n\n> a quote\n[!user] not a header\nShort waves scatter [1:02].', ts: t1 + 1000 },
    ],
  };
  const md = vault.chatToMd(video, chat);
  assert.ok(md.includes('> [!user] 2026-09-04 13:31:26\n> why blue?\n'));
  assert.ok(md.includes('> [!assistant] 2026-09-04 13:31:27\n> ### Rayleigh\n>\n> ---\n>\n> > a quote\n'));
  assert.ok(!md.includes('<!--'));
  const back = vault.parseChat(md);
  assert.equal(back.id, 'c1', 'uuid in front matter');
  assert.equal(back.title, chat.title);
  assert.equal(back.createdAt, Math.floor(chat.createdAt / 1000) * 1000, 'second precision');
  assert.equal(vault.parseChat('---\ncreated: "2026-09-04T11:38:02.236Z"\n---\n').createdAt, Date.parse('2026-09-04T11:38:02.236Z'), 'legacy ISO still parses');
  assert.deepEqual(back.messages, chat.messages);
  assert.deepEqual(vault.parseChat('# empty\n').messages, []);
  const legacy = '# t\n\n<!-- ytx:user ts=1 -->\n### You\n\nhi\n\n<!-- ytx:assistant ts=2 -->\n### Assistant\n\nyo\n';
  assert.deepEqual(vault.parseChat(legacy).messages, [{ role: 'user', ts: 1, content: 'hi' }, { role: 'assistant', ts: 2, content: 'yo' }]);
});

test('pinToMd has title, link and timestamped transcript lines', () => {
  const v = db.blankVideo('abc', 'My Video', 'Chan');
  v.transcript = { grouped: [{ start: 65, end: 70, text: 'hello' }] };
  const md = vault.pinToMd(v);
  assert.ok(md.includes('# My Video'));
  assert.ok(md.includes('- [1:05](https://www.youtube.com/watch?v=abc&t=65s) hello'));
  assert.ok(md.includes('ytx: "video"'));
});

test('sync writes files under <vault>/YT-transcriber/<video>/{notes,chats}, renames on title change, deletes', async () => {
  files.clear();
  const v = db.blankVideo('abc', 'A/B: Title?', 'Chan');
  const card = { id: 'n1', kind: 'quick', text: 'Idea one\ndetails', start: null, color: 0, ts: 1 };
  v.notes.cards.push(card);
  await vault.syncNote(settings, v, card);
  assert.equal(v.folder, 'AB Title');
  assert.ok(files.has('C:\\Vault/YT-transcriber/AB Title/notes/Idea one.md'));
  card.text = 'Idea two';
  await vault.syncNote(settings, v, card);
  assert.ok(!files.has('C:\\Vault/YT-transcriber/AB Title/notes/Idea one.md'));
  assert.ok(files.has('C:\\Vault/YT-transcriber/AB Title/notes/Idea two.md'));
  await vault.removeNote(settings, v, card);
  assert.equal(files.size, 0);

  const blank = { id: 'n2', kind: 'quick', text: '   ', start: null, color: 0, ts: 1 };
  await vault.syncNote(settings, v, blank);
  assert.equal(files.size, 0, 'blank cards do not create files');

  const chat = db.newChat();
  v.chats.push(chat);
  await vault.syncChat(settings, v, chat);
  assert.equal(files.size, 0, 'empty chats do not create files');
  v.transcript = { lang: 'en', grouped: [{ start: 65, end: 70, text: 'hello' }] };
  chat.messages.push({ role: 'user', content: 'hi', ts: 1 });
  await vault.syncChat(settings, v, chat);
  assert.ok(files.has('C:\\Vault/YT-transcriber/AB Title/chats/New chat.md'));
  assert.ok(files.get('C:\\Vault/YT-transcriber/AB Title/Transcript.md').includes('- [1:05](https://www.youtube.com/watch?v=abc&t=65s) hello'), 'Transcript.md written with the folder');
  assert.ok(dirs.has('C:\\Vault/YT-transcriber/AB Title/notes') && dirs.has('C:\\Vault/YT-transcriber/AB Title/chats'), 'both subfolders created');
  chat.title = 'Greetings';
  await vault.syncChat(settings, v, chat);
  assert.deepEqual([...files.keys()].sort(), ['C:\\Vault/YT-transcriber/AB Title/Transcript.md', 'C:\\Vault/YT-transcriber/AB Title/chats/Greetings.md']);

  await vault.pin(settings, v);
  assert.ok(v.pinned);
  assert.deepEqual([...files.keys()].sort(), [
    'C:\\Vault/YT-transcriber/pinned/AB Title/AB Title.md',
    'C:\\Vault/YT-transcriber/pinned/AB Title/Transcript.md',
    'C:\\Vault/YT-transcriber/pinned/AB Title/chats/Greetings.md',
  ], 'whole video folder moved under pinned/, summary added');
  chat.messages.push({ role: 'assistant', content: 'yo', ts: 2 });
  await vault.syncChat(settings, v, chat);
  assert.ok(files.has('C:\\Vault/YT-transcriber/pinned/AB Title/chats/Greetings.md'), 'writes follow the pinned location');
  await vault.unpin(settings, v);
  assert.equal(v.pinned, null);
  assert.deepEqual([...files.keys()].sort(), ['C:\\Vault/YT-transcriber/AB Title/Transcript.md', 'C:\\Vault/YT-transcriber/AB Title/chats/Greetings.md'], 'moved back, summary removed');
});

test('hydrate: disk wins for files, local items without files get written, missing files drop items', async () => {
  files.clear();
  const v = db.blankVideo('abc', 'Vid', 'Chan');
  v.notes.cards.push({ id: 'old', kind: 'quick', text: 'gone from disk', start: null, color: 0, ts: 1, file: 'gone from disk' });
  v.notes.cards.push({ id: 'local', kind: 'quick', text: 'never written', start: 5, color: 2, ts: 2 });
  const c = db.newChat('Old');
  c.messages.push({ role: 'user', content: 'q', ts: 1 });
  v.chats.push(c);
  const base = 'C:\\Vault/YT-transcriber/Vid';
  files.set(`${base}/notes/Handwritten.md`, 'typed in Obsidian\n');
  files.set(`${base}/chats/From disk.md`, vault.chatToMd(v, { title: 'x', createdAt: 1, updatedAt: 2,
    messages: [{ role: 'user', content: 'a', ts: 1 }, { role: 'assistant', content: 'b', ts: 2 }] }));

  await vault.hydrate(settings, v);

  const names = v.notes.cards.map((x) => x.file).sort();
  assert.deepEqual(names, ['Handwritten', 'never written']);
  const hand = v.notes.cards.find((x) => x.file === 'Handwritten');
  assert.equal(hand.text, 'typed in Obsidian');
  assert.equal(hand.kind, 'note');
  assert.equal(hand.title, 'Handwritten', 'hand-written file = note titled by filename');
  assert.ok(files.has(`${base}/notes/never written.md`));
  assert.deepEqual(v.chats.map((x) => x.title), ['From disk', 'Old']);
  assert.equal(v.chats[0].messages.length, 2);
  assert.ok(files.has(`${base}/chats/Old.md`));
  assert.equal(v.activeChatId, v.chats[1].id);

  // second hydrate is stable and keeps ids
  const ids = v.notes.cards.map((x) => x.id).sort();
  await vault.hydrate(settings, v);
  assert.deepEqual(v.notes.cards.map((x) => x.id).sort(), ids);
});

test('hydrate detects a folder moved into pinned/ by hand', async () => {
  files.clear();
  const v = db.blankVideo('abc', 'Vid');
  files.set('C:\\Vault/YT-transcriber/pinned/Vid/notes/x.md', 'hi');
  await vault.hydrate(settings, v);
  assert.ok(v.pinned, 'pinned because the folder lives under pinned/');
  assert.equal(v.notes.cards[0].text, 'hi');
});

test('hydrate is a no-op without vaultDir', async () => {
  const v = db.blankVideo('abc', 'Vid');
  v.notes.cards.push({ id: 'k', kind: 'quick', text: 'keep', start: null, color: 0, ts: 1 });
  await vault.hydrate({ vaultDir: '' }, v);
  assert.equal(v.notes.cards.length, 1);
});

test('cleanTitle / videoFolder: the placeholder "YouTube" title never becomes a folder', async () => {
  assert.equal(vault.cleanTitle('YouTube'), '');
  assert.equal(vault.cleanTitle('youtube'), '');
  assert.equal(vault.cleanTitle(' - YouTube'), '');
  assert.equal(vault.cleanTitle('Real title - YouTube'), 'Real title');
  assert.equal(vault.cleanTitle(''), '');
  files.clear();
  const v = db.blankVideo('abc', 'YouTube');
  const card = { id: 'n', kind: 'quick', text: 'x', start: null, color: 0, ts: 1 };
  v.notes.cards.push(card);
  await assert.rejects(vault.syncNote(settings, v, card), /no-title/);
  assert.equal(v.folder, null, 'folder not frozen');
  assert.equal(files.size, 0, 'nothing written');
  await vault.hydrate(settings, v);
  assert.equal(v.folder, null, 'hydrate waits for a real title too');
  v.title = 'Now real';
  await vault.syncNote(settings, v, card);
  assert.equal(v.folder, 'Now real');
});

test('hydrate keeps identity by uuid when a file was renamed in Obsidian', async () => {
  files.clear();
  const v = db.blankVideo('abc', 'Vid');
  const card = { id: 'keep-me', kind: 'note', title: 'Old name', text: 'body', start: null, color: 0, ts: 1 };
  v.notes.cards.push(card);
  await vault.syncNote(settings, v, card);
  const base = 'C:\\Vault/YT-transcriber/Vid';
  files.set(`${base}/notes/New name.md`, files.get(`${base}/notes/Old name.md`));
  files.delete(`${base}/notes/Old name.md`);
  const chat = db.newChat('Chat A');
  chat.messages.push({ role: 'user', content: 'q', ts: 1 });
  v.chats.push(chat);
  await vault.syncChat(settings, v, chat);
  files.set(`${base}/chats/Chat B.md`, files.get(`${base}/chats/Chat A.md`));
  files.delete(`${base}/chats/Chat A.md`);
  await vault.hydrate(settings, v);
  assert.equal(v.notes.cards.length, 1);
  assert.equal(v.notes.cards[0].id, 'keep-me');
  assert.equal(v.notes.cards[0].title, 'New name');
  assert.equal(v.chats.length, 1);
  assert.equal(v.chats[0].id, chat.id);
  assert.equal(v.chats[0].title, 'Chat B');
});

test('frontmatter: keys added in Obsidian (tags list, aliases) survive a rewrite', () => {
  const video = { url: 'https://www.youtube.com/watch?v=abc' };
  const md = '---\nytx: "note"\nid: "n1"\nkind: "note"\ntitle: "T"\ntags:\n  - ml\n  - papers\naliases: [x]\n---\nbody';
  const parsed = vault.parseNote(md);
  assert.equal(parsed.text, 'body');
  assert.equal(parsed.fm, 'tags:\n  - ml\n  - papers\naliases: [x]');
  const out = vault.noteToMd(video, { id: 'n1', kind: 'note', title: 'T', text: 'body', ts: 1, ...parsed });
  assert.match(out, /tags:\n  - ml\n  - papers\naliases: \[x\]\n---\nbody$/);
  assert.equal(vault.parseNote(out).fm, parsed.fm);
  const chat = vault.parseChat('---\nytx: "chat"\nid: "c1"\ncssclasses: wide\n---\n# t\n');
  assert.equal(chat.fm, 'cssclasses: wide');
});

test('chat: a content line that looks like a callout header does not become a message', () => {
  const video = { url: 'u' };
  const chat = { id: 'c', title: 'T', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'hi\n[!assistant] fake\nend', ts: 3 }] };
  const md = vault.chatToMd(video, chat);
  const back = vault.parseChat(md);
  assert.equal(back.messages.length, 1);
  assert.equal(back.messages[0].content, 'hi\n[!assistant] fake\nend');
});

test('syncNote: file edited on disk since hydrate → disk wins, card reloaded, nothing written', async () => {
  files.clear(); mtimes.clear();
  const video = db.blankVideo('vid9', 'Conflict video');
  const card = { id: 'k1', kind: 'quick', title: '', text: 'mine v1', start: null, color: 0, ts: 1 };
  video.notes.cards.push(card);
  assert.equal(await vault.syncNote(settings, video, card), 'written');
  assert.ok(card.mtime);
  const p = [...files.keys()].find((k) => k.endsWith('/notes/mine v1.md'));
  writeDisk(p, files.get(p).replace('mine v1', 'edited in obsidian'));
  card.text = 'mine v2';
  assert.equal(await vault.syncNote(settings, video, card), 'reloaded');
  assert.equal(card.text, 'edited in obsidian');
  assert.match(files.get(p), /edited in obsidian/);
  assert.equal(await vault.syncNote(settings, video, card), 'written'); // in sync again
});

test('every file op carries the vault root', async () => {
  files.clear(); mtimes.clear();
  const video = db.blankVideo('vid10', 'Rooted');
  const chat = { ...db.newChat('t'), messages: [{ role: 'user', content: 'x', ts: 1 }] };
  video.chats.push(chat);
  await vault.syncChat(settings, video, chat); // fake host rejects root-less ops
  await vault.pin(settings, video);
  await vault.hydrate(settings, video);
});
