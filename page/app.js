import { fmtTime } from '../src/lib/format.js';
import * as db from '../src/lib/db.js';
import * as llm from '../src/lib/llm.js';
import * as vault from '../src/lib/vault.js';
import { createPicker } from '../src/ui/picker.js';
import { createChatBar, confirmBox } from '../src/ui/chatbar.js';
import { createNotesView } from '../src/ui/notes.js';
import { pinIcon, globeIcon } from '../src/ui/icons.js';
import { HOTKEYS, hotkeyId, keysFor } from '../config/hotkeys.js';

const $app = document.getElementById('app');
const TS_RE = /(?:\[(?:\d+:)?\d{1,2}:\d{2}\]|@(?:\d+:)?\d{1,2}:\d{2})/g;

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

let toastTimer;
function toast(content) {
  const t = document.getElementById('toast');
  t.replaceChildren(content);
  t.hidden = false;
  t.classList.remove('fade');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('fade');
    setTimeout(() => { t.hidden = true; }, 300);
  }, 1600);
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

function tsToSeconds(ts) {
  return ts.replace(/[[\]]/g, '').split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
}

// Turn [12:34] in assistant text nodes into links to the video at that time.
function linkTimestamps(root, url) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('a, code, pre')) continue;
    if (node.nodeValue.match(TS_RE)) hits.push(node);
  }
  for (const node of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.nodeValue.matchAll(TS_RE)) {
      frag.append(node.nodeValue.slice(last, m.index));
      const stamp = m[0].replace(/^[[@]|\]$/g, '');
      frag.append(el('a', {
        class: 'chip time', target: '_blank',
        href: atTimeUrl(url, tsToSeconds(stamp)),
      }, stamp));
      last = m.index + m[0].length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

let mermaidReady;
let mermaidSeq = 0;
function ensureMermaid() {
  mermaidReady ??= import('../vendor/mermaid.min.js').then(() => {
    globalThis.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral',
    });
  }).catch((e) => { mermaidReady = undefined; throw e; }); // don't cache a transient load failure
  return mermaidReady;
}

async function renderMermaidIn(root) {
  const blocks = root.querySelectorAll('pre code.language-mermaid');
  if (!blocks.length) return;
  try {
    await ensureMermaid();
  } catch {
    return; // mermaid failed to load: leave fenced blocks as-is (call sites are fire-and-forget)
  }
  for (const code of blocks) {
    try {
      const { svg } = await globalThis.mermaid.render(`ytx-mmd-${++mermaidSeq}`, code.textContent);
      const box = el('div', { class: 'mermaid-box' });
      box.innerHTML = svg;
      code.closest('pre').replaceWith(box);
    } catch { /* leave the fenced block as-is */ }
  }
}

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
  const disk = (fn) => db.getSettings().then((s) => fn(s)).catch(warn);

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
    const list = pane.querySelector('.chat-list');
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
  const list = el('div', { class: 'chat-list' });
  const input = el('textarea', {
    class: 'composer-input mono', rows: 2,
    placeholder: 'Ask about this video… (Enter to send, Shift+Enter for newline)',
  });
  const sendBtn = el('button', { class: 'btn primary' }, 'Send');
  let busy = false;
  let gen = 0; // bumped by cancel; a reply for an older gen is dropped
  let cancel = null;

  const picker = createPicker();
  const cur = () => video.chats.find((c) => c.id === video.activeChatId) ?? null;
  function ensureChat() {
    let c = cur();
    if (!c) { c = db.newChat(); video.chats.push(c); video.activeChatId = c.id; }
    return c;
  }
  function switchTo(id) {
    if (cancel) cancel();
    video.chats = video.chats.filter((c) => c.messages.length || c.id === id); // drop the empty chat we leave
    video.activeChatId = id;
    db.saveVideo(video);
    renderMsgs();
  }
  const bar = createChatBar({
    chats: () => video.chats,
    activeId: () => video.activeChatId,
    onSelect: switchTo,
    onNew: () => {
      if (cur() && !cur().messages.length) return;
      const c = db.newChat();
      video.chats.push(c);
      switchTo(c.id);
      input.focus();
    },
    onRename: (title) => {
      const c = cur();
      if (!c) return;
      c.title = title;
      c.updatedAt = Date.now();
      db.saveVideo(video);
      disk((s) => vault.syncChat(s, video, c));
    },
    onDelete: () => {
      const c = cur();
      if (!c) return;
      list.replaceChildren(confirmBox({
        text: `Delete "${c.title}"? This removes it from the knowledge base too.`,
        onCancel: renderMsgs,
        onConfirm: () => {
          if (cancel) cancel();
          video.chats = video.chats.filter((x) => x.id !== c.id);
          video.activeChatId = video.chats.at(-1)?.id ?? null;
          db.saveVideo(video);
          disk((s) => vault.removeChat(s, video, c));
          renderMsgs();
        },
      }));
    },
  });

  function bubble(m) {
    const b = el('div', { class: `msg ${m.role}` });
    if (m.role === 'assistant') {
      // FORBID_TAGS img: a prompt-injected transcript could make the LLM emit an image URL that exfiltrates chat content on fetch
      b.innerHTML = DOMPurify.sanitize(marked.parse(m.content), { FORBID_TAGS: ['img'] });
      for (const a of b.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
      linkTimestamps(b, video.url);
      renderMermaidIn(b);
      const c = el('button', { class: 'copy-btn', title: 'Copy message' }, '⧉');
      c.addEventListener('click', () => {
        navigator.clipboard.writeText(m.content).then(() => {
          c.textContent = '✓';
          setTimeout(() => { c.textContent = '⧉'; }, 1200);
        }).catch(() => {});
      });
      b.appendChild(c);
    } else {
      b.textContent = m.content;
    }
    return b;
  }

  function renderMsgs() {
    bar.refresh();
    list.replaceChildren(...(cur()?.messages ?? []).map(bubble));
    list.scrollTop = list.scrollHeight;
  }

  function autoTitle(chat, settings) {
    if (chat.title !== db.NEW_CHAT_TITLE || chat.messages.length !== 2) return;
    llm.titleChat({ settings, messages: chat.messages }).then((t) => {
      if (!t || chat.title !== db.NEW_CHAT_TITLE) return;
      chat.title = t;
      chat.updatedAt = Date.now();
      db.saveVideo(video);
      bar.refresh();
      disk((s) => vault.syncChat(s, video, chat));
    }).catch((e) => console.warn('title', e));
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    const myGen = ++gen;
    input.value = '';
    input.disabled = sendBtn.disabled = true;
    const chat = ensureChat();
    chat.messages.push({ role: 'user', content: text, ts: Date.now() });
    chat.updatedAt = Date.now();
    // catch: a failed write must not skip the try/finally below and wedge `busy`
    await db.saveVideo(video).catch((e) => console.warn('save failed', e));
    renderMsgs();
    const pending = el('div', { class: 'msg assistant pending' }, 'Thinking…');
    list.append(pending);
    list.scrollTop = list.scrollHeight;
    const done = () => { busy = false; input.disabled = sendBtn.disabled = false; input.focus(); };
    cancel = () => { gen++; pending.remove(); done(); cancel = null; };
    try {
      const settings = await db.getSettings();
      if (settings.webSearch) pending.textContent = 'Thinking… (web search on)';
      const reply = await llm.chat({
        settings,
        system: llm.buildSystemPrompt({
          title: video.title,
          channel: video.channel,
          segments: video.transcript?.grouped ?? [],
          aboutMe: settings.aboutMe,
          tone: settings.tone,
          webSearch: !!settings.webSearch,
        }),
        messages: chat.messages.map(({ role, content }) => ({ role, content })),
      });
      if (myGen !== gen) return;
      chat.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
      chat.updatedAt = Date.now();
      await db.saveVideo(video);
      disk((s) => vault.syncChat(s, video, chat));
      autoTitle(chat, settings);
      if (cur() === chat) renderMsgs();
    } catch (err) {
      if (myGen !== gen) return;
      pending.remove();
      list.append(el('div', { class: 'msg system' },
        err.message === 'no-api-key'
          ? el('span', {}, 'Add your API key in ', el('a', { href: '#/settings' }, 'Settings'), '.')
          : `Error: ${err.message}`));
      list.scrollTop = list.scrollHeight;
    } finally {
      if (myGen === gen) { cancel = null; done(); }
    }
  }

  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cancel) cancel();
  });
  sendBtn.onclick = send;
  const webBtn = el('button', { class: 'web-btn' }, globeIcon());
  const paintWeb = (on) => {
    webBtn.classList.toggle('on', !!on);
    webBtn.title = (on ? 'Web search on' : 'Web search off') + ` (${keysFor('webSearch')})`;
  };
  db.getSettings().then((s) => paintWeb(s.webSearch));
  const toggleWeb = async () => {
    const s = await db.getSettings();
    await db.saveSettings({ webSearch: !s.webSearch });
    paintWeb(!s.webSearch);
    toast(!s.webSearch ? 'Web search on' : 'Web search off');
  };
  webBtn.onclick = toggleWeb;
  renderMsgs();
  const root = el('div', { class: 'chat' }, bar.root, list,
    el('div', { class: 'composer' },
      el('div', { class: 'input-pill' }, input,
        el('div', { class: 'tool-row' }, webBtn, el('span', { class: 'spacer' }), picker, sendBtn))));
  root.__toggleWeb = toggleWeb;
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
    renderMd: (text) => {
      const box = el('div', { class: 'ytx-md' });
      // FORBID_TAGS img: same reasoning as chat bubbles
      box.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['img'] });
      linkTimestamps(box, video.url);
      return box;
    },
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
      const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }));
      const a = el('a', { href: url, download: 'yt-transcriber-export.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  }, 'Export data');

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
      el('div', { class: 'settings-actions' }, saveBtn, testBtn('anthropic', 'Anthropic'), testBtn('openai', 'OpenAI'), testHostBtn, exportBtn)));
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
