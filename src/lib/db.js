// storage.local wrapper. Keys: `settings`, `video:<videoId>`, `models:<provider>`.

export const DEFAULT_SETTINGS = {
  anthropicKey: '',
  openaiKey: '',
  model: 'anthropic:claude-sonnet-5', // '<provider>:<model id>', picked in the chat composer
  effort: 'off', // 'off' | 'low' | 'medium' | 'high' — thinking / reasoning effort
  aboutMe: '', // system prompt: who the user is
  tone: '', // system prompt: tone of voice
  vaultDir: '', // knowledge base folder (e.g. Obsidian vault); '' = local storage only
  hotkeys: true, // keyboard shortcuts on/off (list in config/hotkeys.js)
  webSearch: false, // let the model search the web (server-side tool); toggled in the chat composer
};

// v1 settings were { provider, apiKey, model } — map into per-provider keys once. Notion keys dropped.
function migrate(s) {
  if (!s) return s;
  const { provider = 'anthropic', apiKey, model, notionToken, notionDatabaseId, ...rest } = s;
  const out = { ...rest };
  if (!('apiKey' in s)) return out;
  if (apiKey && !out[`${provider}Key`]) out[`${provider}Key`] = apiKey;
  if (model && !String(model).includes(':')) out.model = `${provider}:${model}`;
  else if (model) out.model = model;
  return out;
}

export async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...migrate(settings) };
}

export async function saveSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: merged });
  return merged;
}

const MODEL_TTL = 24 * 3600 * 1000;

export async function getCachedModels(provider) {
  const key = `models:${provider}`;
  const r = await browser.storage.local.get(key);
  const c = r[key];
  return c && Date.now() - c.ts < MODEL_TTL ? c.ids : null;
}

export async function setCachedModels(provider, ids) {
  await browser.storage.local.set({ [`models:${provider}`]: { ids, ts: Date.now() } });
}

export async function clearCachedModels() {
  await browser.storage.local.remove(['models:anthropic', 'models:openai']);
}

export const NEW_CHAT_TITLE = 'New chat';

export function newChat(title = NEW_CHAT_TITLE) {
  const now = Date.now();
  return { id: crypto.randomUUID(), title, messages: [], createdAt: now, updatedAt: now };
}

export function blankVideo(videoId, title = '', channel = '') {
  const now = Date.now();
  return {
    videoId,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    savedAt: now,
    updatedAt: now,
    transcript: null,
    chats: [],
    activeChatId: null,
    notes: { cards: [] }, // cards: [{id, kind: 'quick'|'note', title, text, start, color, ts, file?}]
    pinned: null,
    folder: null, // vault folder name, frozen on first disk write (title may change later)
  };
}

// v1 records had `chat: [msgs]` + `bookmarked` (Notion); v2 had `notes.overview` and untyped cards.
// Map once, in memory; next save persists.
function migrateVideo(v) {
  if (!v) return v;
  if (!Array.isArray(v.chats)) {
    const { chat = [], bookmarked, ...rest } = v;
    const chats = chat.length
      ? [{ ...newChat('Chat 1'), messages: chat, createdAt: chat[0].ts, updatedAt: chat[chat.length - 1].ts }]
      : [];
    v = { ...rest, chats, activeChatId: chats[0]?.id ?? null, pinned: null, folder: null };
  }
  if (/^youtube$/i.test(String(v.title ?? '').trim())) v = { ...v, title: '' };
  if (/^youtube$/i.test(String(v.folder ?? ''))) v = { ...v, folder: null };
  const notes = { ...(v.notes ?? {}) };
  notes.cards = (notes.cards ?? []).map((c) => ({ kind: 'quick', title: '', ...c }));
  if (typeof notes.overview === 'string') {
    if (notes.overview.trim()) {
      notes.cards.push({ id: crypto.randomUUID(), kind: 'note', title: 'Overview', text: notes.overview, start: null, color: 0, ts: Date.now() });
    }
    delete notes.overview;
  }
  return { ...v, notes };
}

export async function getVideo(videoId) {
  const key = `video:${videoId}`;
  const r = await browser.storage.local.get(key);
  return migrateVideo(r[key] ?? null);
}

export async function saveVideo(video) {
  video.updatedAt = Date.now();
  await browser.storage.local.set({ [`video:${video.videoId}`]: video });
  return video;
}

export async function deleteVideo(videoId) {
  await browser.storage.local.remove(`video:${videoId}`);
}

export async function listVideos() {
  const all = await browser.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('video:'))
    .map(([, raw]) => {
      const v = migrateVideo(raw);
      return {
        videoId: v.videoId,
        title: v.title,
        channel: v.channel,
        url: v.url,
        updatedAt: v.updatedAt,
        counts: {
          segments: v.transcript?.segments?.length ?? 0,
          messages: v.chats.reduce((n, c) => n + c.messages.length, 0),
          cards: v.notes?.cards?.length ?? 0,
        },
        pinned: !!v.pinned,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
