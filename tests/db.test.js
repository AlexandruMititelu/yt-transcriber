import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        if (key === null) return Object.fromEntries(store);
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      async remove(key) {
        for (const k of [].concat(key)) store.delete(k);
      },
    },
  },
};

const db = await import('../src/lib/db.js');

test('getSettings returns defaults when nothing stored', async () => {
  store.clear();
  assert.deepEqual(await db.getSettings(), db.DEFAULT_SETTINGS);
  assert.equal(db.DEFAULT_SETTINGS.model, 'anthropic:claude-sonnet-5');
  assert.equal(db.DEFAULT_SETTINGS.effort, 'off');
});

test('saveSettings merges patch over defaults and persists', async () => {
  store.clear();
  const merged = await db.saveSettings({ anthropicKey: 'sk-1' });
  assert.equal(merged.anthropicKey, 'sk-1');
  assert.equal(merged.effort, 'off');
  const again = await db.saveSettings({ effort: 'high' });
  assert.equal(again.anthropicKey, 'sk-1'); // earlier patch preserved
  assert.equal(again.effort, 'high');
  assert.deepEqual(await db.getSettings(), again);
});

test('getSettings migrates v1 {provider, apiKey, model} and saveSettings drops the legacy keys', async () => {
  store.clear();
  store.set('settings', { provider: 'openai', apiKey: 'sk-old', model: 'gpt-4o', notionToken: 'n' });
  const s = await db.getSettings();
  assert.equal(s.openaiKey, 'sk-old');
  assert.equal(s.anthropicKey, '');
  assert.equal(s.model, 'openai:gpt-4o');
  assert.equal(s.vaultDir, '');
  assert.ok(!('apiKey' in s) && !('provider' in s) && !('notionToken' in s));
  await db.saveSettings({});
  assert.ok(!('apiKey' in store.get('settings')));
});

test('model cache: set/get within TTL, clear removes', async () => {
  store.clear();
  assert.equal(await db.getCachedModels('openai'), null);
  await db.setCachedModels('openai', ['gpt-5.1']);
  assert.deepEqual(await db.getCachedModels('openai'), ['gpt-5.1']);
  store.set('models:openai', { ids: ['stale'], ts: Date.now() - 25 * 3600 * 1000 });
  assert.equal(await db.getCachedModels('openai'), null);
  await db.setCachedModels('anthropic', ['a']);
  await db.clearCachedModels();
  assert.equal(await db.getCachedModels('anthropic'), null);
});

test('blankVideo has the contract record shape', () => {
  const v = db.blankVideo('abc123', 'Title', 'Channel');
  assert.equal(v.videoId, 'abc123');
  assert.equal(v.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(v.transcript, null);
  assert.deepEqual(v.chats, []);
  assert.equal(v.activeChatId, null);
  assert.deepEqual(v.notes, { cards: [] });
  assert.equal(v.pinned, null);
  assert.equal(v.folder, null);
  assert.equal(typeof v.savedAt, 'number');
});

test('saveVideo/getVideo roundtrip, updatedAt stamped', async () => {
  store.clear();
  const v = db.blankVideo('vid1', 'T', 'C');
  v.updatedAt = 0;
  const saved = await db.saveVideo(v);
  assert.ok(saved.updatedAt > 0, 'updatedAt stamped on save');
  const got = await db.getVideo('vid1');
  assert.deepEqual(got, saved);
  assert.equal(await db.getVideo('missing'), null);
});

test('listVideos sorts by updatedAt desc with counts and bookmarked flag', async () => {
  store.clear();
  const a = db.blankVideo('a', 'A', 'ch');
  a.transcript = { lang: 'en', trackName: 'English', segments: [{ start: 0, dur: 1, text: 'x' }], grouped: [] };
  const chat = db.newChat();
  chat.messages = [{ role: 'user', content: 'hi', ts: 1 }, { role: 'assistant', content: 'yo', ts: 2 }];
  a.chats = [chat];
  a.notes.cards = [{ id: '1', text: 'n', start: null, color: 0, ts: 1 }];
  await db.saveVideo(a);
  const b = db.blankVideo('b', 'B', 'ch');
  b.pinned = { file: 'f', at: 1 };
  await db.saveVideo(b);
  b.updatedAt = a.updatedAt + 1000;
  store.set('video:b', b); // force b newer

  const list = await db.listVideos();
  assert.deepEqual(list.map((x) => x.videoId), ['b', 'a']);
  assert.deepEqual(list[1].counts, { segments: 1, messages: 2, cards: 1 });
  assert.equal(list[0].pinned, true);
  assert.equal(list[1].pinned, false);
  assert.equal(list[1].url, 'https://www.youtube.com/watch?v=a');
});

test('listVideos ignores non-video keys', async () => {
  store.clear();
  await db.saveSettings({});
  await db.saveVideo(db.blankVideo('only'));
  const list = await db.listVideos();
  assert.equal(list.length, 1);
  assert.equal(list[0].videoId, 'only');
});

test('deleteVideo removes the record', async () => {
  store.clear();
  await db.saveVideo(db.blankVideo('gone'));
  assert.ok(await db.getVideo('gone'));
  await db.deleteVideo('gone');
  assert.equal(await db.getVideo('gone'), null);
});

test('getVideo/listVideos migrate v1 records: chat[] → chats[], bookmarked dropped', async () => {
  store.clear();
  store.set('video:v1', {
    videoId: 'v1', title: 'Old', channel: '', url: 'https://www.youtube.com/watch?v=v1', savedAt: 1, updatedAt: 2,
    transcript: null, chat: [{ role: 'user', content: 'hi', ts: 10 }, { role: 'assistant', content: 'yo', ts: 20 }],
    notes: { overview: '', cards: [] }, bookmarked: { pageId: 'p', pageUrl: 'u', at: 1 },
  });
  const v = await db.getVideo('v1');
  assert.ok(!('chat' in v) && !('bookmarked' in v));
  assert.equal(v.chats.length, 1);
  assert.equal(v.chats[0].title, 'Chat 1');
  assert.equal(v.chats[0].messages.length, 2);
  assert.equal(v.chats[0].createdAt, 10);
  assert.equal(v.activeChatId, v.chats[0].id);
  assert.equal(v.pinned, null);
  assert.deepEqual(v.notes, { cards: [] });
  const [row] = await db.listVideos();
  assert.equal(row.counts.messages, 2);
  assert.equal(row.pinned, false);
});

test('getVideo migrates v2 notes: overview → a note card, untyped cards → quick', async () => {
  store.clear();
  const v = db.blankVideo('v2', 'T');
  v.notes = { overview: 'big picture', cards: [{ id: 'c', text: 'q', start: null, color: 1, ts: 1 }] };
  store.set('video:v2', v);
  const got = await db.getVideo('v2');
  assert.ok(!('overview' in got.notes));
  assert.equal(got.notes.cards[0].kind, 'quick');
  assert.equal(got.notes.cards[0].title, '');
  assert.equal(got.notes.cards[1].kind, 'note');
  assert.equal(got.notes.cards[1].title, 'Overview');
  assert.equal(got.notes.cards[1].text, 'big picture');
});

test('getVideo heals records that froze the "YouTube" placeholder as title/folder', async () => {
  store.clear();
  const v = db.blankVideo('yt', 'YouTube');
  v.folder = 'YouTube';
  store.set('video:yt', v);
  const got = await db.getVideo('yt');
  assert.equal(got.title, '');
  assert.equal(got.folder, null);
});

test('v2 settings keep model/effort/webSearch across getSettings (regression: model reset on load)', async () => {
  store.clear();
  await db.saveSettings({ model: 'openai:gpt-5.1', effort: 'high', webSearch: true, notionToken: 'x' });
  const s = await db.getSettings();
  assert.equal(s.model, 'openai:gpt-5.1');
  assert.equal(s.effort, 'high');
  assert.equal(s.webSearch, true);
  assert.equal('notionToken' in s, false);
});
