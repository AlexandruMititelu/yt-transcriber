import { fmtTime } from '../src/lib/format.js';
import * as db from '../src/lib/db.js';
import * as llm from '../src/lib/llm.js';
import * as vault from '../src/lib/vault.js';
import { confirmBox } from '../src/ui/chatbar.js';
import { createNotesView } from '../src/ui/notes.js';
import { createChatView } from '../src/ui/chat.js';
import { renderMarkdown, setDark } from '../src/ui/markdown.js';
import { createToaster } from '../src/ui/toast.js';
import { pinIcon } from '../src/ui/icons.js';
import { HOTKEYS, hotkeyId } from '../config/hotkeys.js';

const $app = document.getElementById('app');
const toast = createToaster(document.body, { fixed: true });

// ---------- helpers ----------

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function relTime(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function atTimeUrl(url, sec) {
  return `${url}&t=${Math.floor(sec)}s`;
}

const renderMdFor = (video) => (text) => renderMarkdown(text, { timeHref: (sec) => atTimeUrl(video.url, sec) });

// ---------- library ----------

let libFilter = 'all'; // 'all' | 'pinned' (session-scoped)

async function renderLibrary() {
  const vids = await db.listVideos();
  const pinned = vids.filter((v) => v.pinned);
  const rest = vids.filter((v) => !v.pinned);
  const header = el('header', { class: 'topbar' },
    el('h1', {}, 'YT Transcriber'),
    el('a', { class: 'icon-btn', href: '#/settings', title: 'Settings' }, '⚙'));
  const seg = el('div', { class: 'segmented' }, [['all', 'All'], ['pinned', 'Pinned']].map(([key, label]) =>
    el('button', { class: `seg-btn${libFilter === key ? ' active' : ''}`, onclick: () => { libFilter = key; renderLibrary(); } }, label)));
  const section = (title, list) => el('section', { class: 'lib-section' },
    title ? el('h2', { class: 'lib-title' }, title) : null,
    el('div', { class: 'grid' }, list.map(videoCard)));
  let body;
  if (!vids.length) {
    body = el('div', { class: 'empty' },
      el('p', {}, 'No videos yet.'),
      el('p', { class: 'hint' }, 'Open a YouTube video — the transcript panel saves everything here.'));
  } else if (libFilter === 'pinned') {
    body = pinned.length ? section(null, pinned)
      : el('div', { class: 'empty' }, el('p', {}, 'Nothing pinned.'), el('p', { class: 'hint' }, 'Hover a video and click the pin.'));
  } else {
    body = el('div', {},
      pinned.length ? section('Pinned', pinned) : null,
      rest.length ? section(pinned.length ? 'Everything else' : null, rest) : null);
  }
  $app.replaceChildren(header, seg, body);
}

async function togglePin(videoId) {
  const video = await db.getVideo(videoId);
  if (!video) return;
  const settings = await db.getSettings();
  if (video.pinned) await vault.unpin(settings, video);
  else await vault.pin(settings, video);
  await db.saveVideo(video);
  toast(video.pinned ? 'Pinned' : 'Unpinned');
}

function videoCard(v) {
  const del = el('button', {
    class: 'card-del icon-btn', title: 'Delete',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete "${v.title || v.videoId}"?`)) return;
      await db.deleteVideo(v.videoId);
      renderLibrary();
    },
  }, '⌫');
  const pin = el('button', {
    class: `card-pin icon-btn pin${v.pinned ? ' on' : ''}`, title: v.pinned ? 'Unpin' : 'Pin',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      pin.disabled = true;
      try {
        await togglePin(v.videoId);
        renderLibrary();
      } catch (err) {
        pin.disabled = false;
        toast(err.message === 'no-vault'
          ? el('span', {}, 'Set the knowledge base folder in ', el('a', { href: '#/settings' }, 'Settings'))
          : `Pin failed: ${err.message}`);
      }
    },
  }, pinIcon());
  return el('a', { class: 'card', href: `#/video/${v.videoId}` },
    el('div', { class: 'card-title' }, v.title || v.videoId),
    el('div', { class: 'card-meta' }, [v.channel, relTime(v.updatedAt)].filter(Boolean).join(' · ')),
    el('div', { class: 'card-badges' },
      `${v.counts.segments} segments · ${v.counts.messages} messages · ${v.counts.cards} notes`),
    el('div', { class: 'card-actions' }, pin, del));
}

// ---------- video detail ----------

async function renderDetail(videoId) {
  const video = await db.getVideo(videoId);
  if (!video) {
    $app.replaceChildren(el('div', { class: 'empty' },
      el('p', {}, 'Video not found.'),
      el('a', { href: '#/' }, 'Back to library')));
    return;
  }

  // Knowledge base folder set → files on disk are the truth; pull them in before rendering.
  let warned = false;
  const warn = (e) => { console.warn('knowledge base', e); if (!warned) { warned = true; toast(`Knowledge base: ${e.message}`); } };
  // Disk wins on conflict: a sync that returns 'reloaded' pulled the Obsidian edit in; rebuild panes.
  const disk = (fn) => db.getSettings().then((s) => fn(s)).then((r) => {
    if (r !== 'reloaded') return;
    db.saveVideo(video);
    for (const k of Object.keys(built)) delete built[k];
    show(seg.querySelector('.seg-btn.active')?.dataset.tab || 'Transcript');
    toast('Changed in Obsidian: reloaded from disk');
  }).catch(warn);

  const pinBtn = el('button', { class: 'icon-btn pin' }, pinIcon());
  const paintPin = () => {
    pinBtn.classList.toggle('on', !!video.pinned);
    pinBtn.title = video.pinned ? 'Pinned (in YT-transcriber/pinned). Click to unpin' : 'Pin: move this video into YT-transcriber/pinned';
  };
  paintPin();
  pinBtn.onclick = async () => {
    pinBtn.disabled = true;
    try {
      const wasPinned = !!video.pinned;
      if (wasPinned) await vault.unpin(await db.getSettings(), video);
      else await vault.pin(await db.getSettings(), video);
      await db.saveVideo(video);
      paintPin();
      toast(wasPinned ? 'Unpinned' : 'Pinned to knowledge base');
    } catch (err) {
      toast(err.message === 'no-vault'
        ? el('span', {}, 'Set the knowledge base folder in ', el('a', { href: '#/settings' }, 'Settings'))
        : `Pin failed: ${err.message}`);
    } finally {
      pinBtn.disabled = false;
    }
  };

  const header = el('header', { class: 'topbar' },
    el('a', { class: 'icon-btn', href: '#/', title: 'Library' }, '‹'),
    el('div', { class: 'detail-head' },
      el('a', { class: 'detail-title', href: video.url, target: '_blank' }, video.title || video.videoId),
      el('div', { class: 'detail-meta' }, video.channel || '')),
    pinBtn);

  const pane = el('div', { class: 'pane' });
  const panes = { Transcript: transcriptPane, Chat: chatPane, Notes: notesPane };
  const seg = el('div', { class: 'segmented' }, Object.keys(panes).map((name) =>
    el('button', { class: 'seg-btn', dataset: { tab: name } }, name)));
  const built = {}; // cache pane instances so chat busy-state and in-flight requests survive tab switches
  function show(name) {
    for (const b of seg.children) b.classList.toggle('active', b.dataset.tab === name);
    pane.replaceChildren(built[name] ??= panes[name](video, disk));
    // scrollHeight is 0 while detached, so renderMsgs' scroll is a no-op — re-scroll on reveal
    const list = pane.querySelector('.ytx-chat-list');
    if (list) list.scrollTop = list.scrollHeight;
  }
  seg.onclick = (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) show(b.dataset.tab);
  };

  $app.replaceChildren(header, seg, pane);
  show('Transcript');
  // Hotkeys (one live handler; replaced on every route change).
  const s1 = await db.getSettings();
  const names = Object.keys(panes);
  detailKeys = (e) => {
    if (e.key === 'Escape') built.Chat?.__cancel?.();
    if (s1.hotkeys === false) return;
    const hk = hotkeyId(e);
    if (!hk) return;
    e.preventDefault();
    const cur = seg.querySelector('.seg-btn.active')?.dataset.tab || 'Transcript';
    if (hk === 'prevTab' || hk === 'nextTab') {
      const i = names.indexOf(cur);
      show(names[(i + (hk === 'nextTab' ? 1 : names.length - 1)) % names.length]);
    } else if (hk === 'webSearch') {
      if (cur === 'Chat') built.Chat?.__toggleWeb?.();
    } else if (built.Notes?.__view) {
      built.Notes.__view.setMode(hk === 'editMode' ? 'edit' : 'view');
    }
  };
  // Hydrate after first paint so a slow or missing host never blocks the page; rebuild panes on arrival.
  (async () => {
    const s0 = await db.getSettings();
    if (!vault.enabled(s0)) return;
    await vault.hydrate(s0, video);
    await db.saveVideo(video);
    paintPin();
    for (const k of Object.keys(built)) delete built[k];
    const active = seg.querySelector('.seg-btn.active')?.dataset.tab || 'Transcript';
    show(active);
  })().catch(warn);
}

function transcriptPane(video) {
  const grouped = video.transcript?.grouped ?? [];
  if (!grouped.length) return el('div', { class: 'empty' }, 'No transcript saved for this video.');
  let clickTimer;
  return el('div', { class: 'seg-list' }, grouped.map((seg) =>
    el('div', {
      class: 'seg',
      onclick: () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => window.open(atTimeUrl(video.url, seg.start), '_blank'), 250);
      },
      ondblclick: () => {
        clearTimeout(clickTimer);
        navigator.clipboard.writeText(`[${fmtTime(seg.start)}] ${seg.text}`)
          .then(() => toast('Copied'), () => toast('Copy failed'));
      },
    },
      el('span', { class: 'chip time' }, fmtTime(seg.start)),
      el('span', { class: 'seg-text' }, seg.text))));
}

function chatPane(video, disk) {
  const view = createChatView({
    video,
    save: () => db.saveVideo(video),
    disk,
    renderMd: renderMdFor(video),
    toast,
    segments: () => video.transcript?.grouped ?? [],
    settingsAction: () => el('a', { href: '#/settings' }, 'Open Settings'),
  });
  const root = el('div', { class: 'chat' }, view.root);
  root.__toggleWeb = view.toggleWeb;
  root.__cancel = view.cancel;
  root.__focus = view.focus;
  return root;
}

function notesPane(video, disk) {
  const dirty = new Set();
  const flush = () => {
    db.saveVideo(video);
    for (const c of dirty) disk((s) => vault.syncNote(s, video, c));
    dirty.clear();
  };
  const saveSoon = debounce(flush, 500);
  const view = createNotesView({
    video,
    fmtTime,
    renderMd: renderMdFor(video),
    timeHref: (sec) => atTimeUrl(video.url, sec),
    onChange: (card) => { dirty.add(card); saveSoon(); },
    onDelete: (card) => { dirty.delete(card); db.saveVideo(video); disk((s) => vault.removeNote(s, video, card)); },
  });
  // ponytail: no "@ time" stamp button here — the library page has no playing video to read time from.
  const root = el('div', { class: 'notes' }, view.root);
  root.__view = view; // hotkeys reach the editor through the cached pane
  return root;
}

// ---------- settings ----------

async function renderSettings() {
  const s = await db.getSettings();

  const anthropicKey = el('input', { class: 'input', type: 'password', autocomplete: 'off' });
  anthropicKey.value = s.anthropicKey;
  const openaiKey = el('input', { class: 'input', type: 'password', autocomplete: 'off' });
  openaiKey.value = s.openaiKey;
  const aboutMe = el('textarea', { class: 'input', rows: 4,
    placeholder: 'e.g. Backend dev, Romanian, learning ML. Prefers concrete examples.' });
  aboutMe.value = s.aboutMe;
  const tone = el('textarea', { class: 'input', rows: 3,
    placeholder: 'e.g. Terse, no fluff, bullet points, dry humor OK.' });
  tone.value = s.tone;
  const hotkeys = el('input', { type: 'checkbox' });
  hotkeys.checked = s.hotkeys !== false;
  const vaultDir = el('input', { class: 'input', placeholder: 'C:\\Users\\you\\Obsidian\\Vault' });
  vaultDir.value = s.vaultDir;
  const chooseBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      chooseBtn.disabled = true;
      try {
        const p = await vault.pickFolder();
        if (p) { vaultDir.value = p; syncSave(); }
      } catch (err) {
        toast(`Native host not reachable: ${err.message}`);
      } finally {
        chooseBtn.disabled = false;
      }
    },
  }, 'Choose…');

  const formValues = () => ({
    anthropicKey: anthropicKey.value.trim(),
    openaiKey: openaiKey.value.trim(),
    aboutMe: aboutMe.value,
    tone: tone.value,
    vaultDir: vaultDir.value.trim().replace(/[\\/]+$/, ''),
    hotkeys: hotkeys.checked,
  });

  // Save is blue only while the form differs from what is stored.
  let saved = JSON.stringify(formValues());
  const saveBtn = el('button', {
    class: 'btn primary',
    onclick: async () => {
      await db.saveSettings(formValues());
      await db.clearCachedModels(); // keys may have changed → refetch model lists
      saved = JSON.stringify(formValues());
      syncSave();
      toast('Settings saved');
    },
  }, 'Save');
  const syncSave = () => { saveBtn.disabled = JSON.stringify(formValues()) === saved; };
  for (const f of [anthropicKey, openaiKey, aboutMe, tone, vaultDir]) f.addEventListener('input', syncSave);
  hotkeys.addEventListener('change', syncSave);
  syncSave();

  const testBtn = (provider, label) => {
    const b = el('button', { class: 'btn' }, `Test ${label} key`);
    b.onclick = async () => {
      b.disabled = true;
      try {
        await llm.chat({
          settings: { ...formValues(), model: `${provider}:${llm.DEFAULT_MODELS[provider]}`, effort: 'off' },
          system: 'You are a connectivity test. Reply with the single word: ok',
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 8,
        });
        toast(`${label} key works`);
      } catch (err) {
        toast(`Test failed: ${err.message}`);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };

  const testHostBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      testHostBtn.disabled = true;
      try {
        const r = await vault.ping();
        toast(`Native host OK (v${r.version}, ${r.platform})`);
      } catch (err) {
        toast(`Native host not reachable: ${err.message}`);
      } finally {
        testHostBtn.disabled = false;
      }
    },
  }, 'Test host');

  const exportBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      const all = await browser.storage.local.get(null);
      // API keys stay out of the file: it lands in Downloads and gets backed up / synced.
      if (all.settings) all.settings = { ...all.settings, anthropicKey: '', openaiKey: '' };
      const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }));
      const a = el('a', { href: url, download: 'yt-transcriber-export.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  }, 'Export data');

  // Import = merge an export back in (videos + non-secret settings). Keys in storage are kept.
  const importInput = el('input', { type: 'file', accept: 'application/json', hidden: '' });
  importInput.onchange = async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data !== 'object') throw new Error('not an export file');
      const videos = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith('video:')));
      const cur = await db.getSettings();
      const { anthropicKey, openaiKey, ...rest } = data.settings ?? {};
      await browser.storage.local.set({ ...videos, settings: { ...cur, ...rest, anthropicKey: cur.anthropicKey || anthropicKey || '', openaiKey: cur.openaiKey || openaiKey || '' } });
      toast(`Imported ${Object.keys(videos).length} videos`);
      renderSettings();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  };
  const importBtn = el('button', { class: 'btn', onclick: () => importInput.click() }, 'Import data');

  const field = (label, input, help) => el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label), input,
    help ? el('span', { class: 'field-help' }, help) : null);

  $app.replaceChildren(
    el('header', { class: 'topbar' },
      el('a', { class: 'icon-btn', href: '#/', title: 'Library' }, '‹'),
      el('h1', {}, 'Settings')),
    el('div', { class: 'settings-form' },
      field('Anthropic API key', anthropicKey, 'Model and thinking effort are picked in the chat composer.'),
      field('OpenAI API key', openaiKey),
      field('About me', aboutMe, 'Added to every chat system prompt so answers fit you.'),
      field('Tone of voice', tone, 'How the assistant should talk.'),
      field('Knowledge base folder', el('div', { class: 'field-row' }, vaultDir, chooseBtn),
        el('span', {}, 'Your Obsidian vault (or any folder). Notes, chats and pinned videos are written as markdown under ',
          el('code', {}, 'YT-transcriber/'), ' inside it, and files there are the source of truth. ',
          'Needs the native host once: run ', el('code', {}, 'native\\install.ps1'), ' (Windows) or ',
          el('code', {}, 'native/install.sh'), ', restart the browser, then Test host.')),
      el('div', { class: 'field' },
        el('label', { class: 'field-check' }, hotkeys, el('span', { class: 'field-label' }, 'Keyboard shortcuts')),
        el('table', { class: 'hotkeys' }, HOTKEYS.map((h) => el('tr', {}, el('td', {}, el('kbd', {}, h.keys)), el('td', {}, h.desc)))),
        el('span', { class: 'field-help' }, 'Fixed for now: turn them all on or off here. Defined in config/hotkeys.js.')),
      el('div', { class: 'settings-actions' }, saveBtn, testBtn('anthropic', 'Anthropic'), testBtn('openai', 'OpenAI'), testHostBtn, exportBtn, importBtn, importInput)));
}

// ---------- router ----------

let detailKeys = null; // installed by renderDetail, cleared on route change
document.addEventListener('keydown', (e) => { if (detailKeys) detailKeys(e); });

function route() {
  detailKeys = null;
  const hash = location.hash || '#/';
  const p = hash.startsWith('#/video/') ? renderDetail(hash.slice('#/video/'.length))
    : hash === '#/settings' ? renderSettings()
    : renderLibrary();
  p.catch((err) => $app.replaceChildren(el('div', { class: 'empty' }, `Error: ${err.message}`)));
}

window.addEventListener('hashchange', route);
route();
