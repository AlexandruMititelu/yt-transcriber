import { fmtTime } from '../src/lib/format.js';
import * as db from '../src/lib/db.js';
import * as llm from '../src/lib/llm.js';
import * as vault from '../src/lib/vault.js';
import * as transcriptLib from '../src/lib/transcript.js';
import { confirmBox } from '../src/ui/chatbar.js';
import { createNotesView } from '../src/ui/notes.js';
import { createChatView } from '../src/ui/chat.js';
import { renderMarkdown, setDark } from '../src/ui/markdown.js';
import { createToaster } from '../src/ui/toast.js';
import { pinIcon, chevronDown, copyIcon, gearIcon, chevronLeft, trashIcon } from '../src/ui/icons.js';
import { createTagEditor, tagChip } from '../src/ui/tags.js';
import { HOTKEYS, hotkeyId } from '../config/hotkeys.js';
import { PROMPTS, promptsToText } from '../config/prompts.js';

const $app = document.getElementById('app');
const toast = createToaster(document.body, { fixed: true });

// ---------- theme (Settings: auto | light | dark) ----------
const osDark = matchMedia('(prefers-color-scheme: dark)');
let themePref = 'auto';
function applyTheme(pref = themePref) {
  themePref = pref;
  if (pref === 'light' || pref === 'dark') document.documentElement.dataset.theme = pref;
  else delete document.documentElement.dataset.theme;
  setDark(pref === 'dark' || (pref === 'auto' && osDark.matches));
}
osDark.addEventListener('change', () => applyTheme());
db.getSettings().then((s) => applyTheme(s.theme || 'auto')).catch(() => {});

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

// Wrap every case-insensitive match of q in <mark>. DOM nodes only — the query is user text.
function highlight(node, text, q) {
  if (!q) { node.replaceChildren(text); return; }
  const lower = text.toLowerCase();
  const parts = [];
  let i = 0;
  for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
    if (j > i) parts.push(text.slice(i, j));
    parts.push(el('mark', { class: 'ytx-hl' }, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  parts.push(text.slice(i));
  node.replaceChildren(...parts);
}

function atTimeUrl(url, sec) {
  return `${url}&t=${Math.floor(sec)}s`;
}

const renderMdFor = (video) => (text) => renderMarkdown(text, { timeHref: (sec) => atTimeUrl(video.url, sec) });

// ---------- library ----------

let libQuery = '';
let libSort = 'recent'; // 'recent' | 'title' | 'channel'
let libTags = new Set(); // tag filter: a video must carry every selected tag
let libGroup = 'none'; // 'none' | 'channel' | 'tag'
let libShell = null; // header + tools, built once per visit to #/ — only the body inside .lib-stage repaints
let libPaint = 0; // paint token: a slow listVideos must never overwrite a newer paint
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const SORTS = [['recent', 'Recent'], ['title', 'Title'], ['channel', 'Channel']];

// macOS-style pop-up button: pill + rotating chevron, menu reuses the chatbar popover look.
// popMenu(paintMenu(menu, close), { cls }) → { wrap, label, btn, close }
function popMenu(paintMenu, { cls = '' } = {}) {
  const label = el('span', {});
  const btn = el('button', { class: `btn lib-dd ${cls}`, type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
    label, el('span', { class: 'lib-dd-caret' }, chevronDown()));
  const menu = el('div', { class: 'ytx-chatbar-menu lib-dd-menu' });
  const wrap = el('div', { class: 'lib-dd-wrap' }, btn, menu);
  const onDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    if (!menu.classList.contains('is-open')) return;
    menu.classList.remove('is-open');
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  }
  btn.onclick = () => {
    if (menu.classList.contains('is-open')) return close();
    paintMenu(menu, close);
    menu.classList.add('is-open');
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  };
  return { wrap, label, btn, close, menu, repaint: () => paintMenu(menu, close) };
}
// Radio list menu (sort, group). options: [[value, label]], get/set the current value.
function choiceMenu(options, get, set, onPick) {
  const m = popMenu((menu, close) => menu.replaceChildren(...options.map(([v, l]) => el('button', {
    class: 'ytx-chatbar-item', type: 'button',
    onclick: () => { close(); if (v === get()) return; set(v); paint(); onPick(); },
  }, el('span', { class: 'ytx-chatbar-check' }, get() === v ? '✓' : ''), el('span', { class: 'ytx-chatbar-text' }, l)))));
  const paint = () => { m.label.textContent = options.find(([v]) => v === get())[1]; };
  paint();
  return m.wrap;
}
const sortMenu = (onPick) => choiceMenu(SORTS, () => libSort, (v) => { libSort = v; }, onPick);
const GROUPS = [['none', 'No grouping'], ['channel', 'By channel'], ['tag', 'By tag']];
const groupMenu = (onPick) => choiceMenu(GROUPS, () => libGroup, (v) => { libGroup = v; }, onPick);
// Tags: every tag in the library as coloured chips with counts; click toggles it in the filter (AND).
let tagCounts = new Map();
function tagMenu(onPick) {
  const m = popMenu((menu) => {
    const chips = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) =>
      tagChip(t, { on: libTags.has(t), count: n, onClick: () => { if (libTags.has(t)) libTags.delete(t); else libTags.add(t); m.repaint(); paint(); onPick(); } }));
    const clear = el('button', { class: 'ytx-chatbar-item', type: 'button', disabled: libTags.size ? null : 'true', onclick: () => { libTags.clear(); m.close(); paint(); onPick(); } },
      el('span', { class: 'ytx-chatbar-check' }, ''), el('span', { class: 'ytx-chatbar-text' }, 'Clear filter'));
    menu.replaceChildren(chips.length ? el('div', { class: 'ytx-tag-row lib-tag-menu' }, chips) : el('div', { class: 'lib-tag-empty' }, 'No tags yet. Tag a video from its header.'), clear);
  }, { cls: 'lib-tagdd' });
  const paint = () => {
    m.label.textContent = libTags.size ? `Tags · ${[...libTags].map((t) => `#${t}`).join(' ')}` : 'Tags';
    m.btn.classList.toggle('on', libTags.size > 0);
  };
  paint();
  return m.wrap;
}

// iPhone-style swap: new body enters from one side, old one slides out on top (absolute) so nothing jumps.
function swapBody(body, transition) {
  const stage = libShell.stage;
  for (const e of stage.querySelectorAll(':scope > .lib-exit')) e.remove();
  const old = stage.firstElementChild;
  if (!old || transition === 'none' || reduceMotion.matches) { stage.replaceChildren(body); return; }
  const [enter, exit] = transition === 'left' ? ['lib-from-right', 'lib-to-left']
    : transition === 'right' ? ['lib-from-left', 'lib-to-right']
      : ['lib-fade', 'lib-fade'];
  body.classList.add('lib-anim', enter);
  old.classList.add('lib-anim', 'lib-exit');
  stage.append(body);
  requestAnimationFrame(() => { body.classList.remove(enter); old.classList.add(exit); });
  const done = (e) => { if (e && e.target !== old) return; clearTimeout(t); old.remove(); }; // transitionend bubbles: ignore card hovers
  old.addEventListener('transitionend', done);
  const t = setTimeout(done, 320); // fallback: transitionend never fires if the tab is hidden
}

function buildLibShell() {
  const logo = el('img', { class: 'logo', alt: '', src: '../assets/logo-light.svg' });
  const header = el('header', { class: 'topbar' },
    el('h1', {}, logo, 'YT Transcriber'),
    el('a', { class: 'icon-btn', href: '#/settings', title: 'Settings', 'aria-label': 'Settings' }, gearIcon()));
  const search = el('input', { class: 'input lib-search', type: 'search', placeholder: 'Search title or channel…', 'aria-label': 'Search videos' });
  search.value = libQuery;
  const searchSoon = debounce(() => paintLibrary('fade'), 150);
  search.oninput = () => { libQuery = search.value; searchSoon(); };
  const group = groupMenu(() => paintLibrary('fade'));
  const tagsDd = tagMenu(() => paintLibrary('fade'));
  const count = el('span', { class: 'lib-count' });
  const stage = el('div', { class: 'lib-stage' }, el('div', { class: 'empty' }, 'Loading…'));
  $app.replaceChildren(header,
    el('div', { class: 'lib-tools' }, search, sortMenu(() => paintLibrary('fade')), group, tagsDd, count),
    stage);
  libShell = { stage, count };
}

async function renderLibrary() {
  const fresh = !libShell || !libShell.stage.isConnected;
  if (fresh) buildLibShell();
  await paintLibrary(fresh ? 'none' : 'fade');
}

async function paintLibrary(transition = 'fade') {
  const token = ++libPaint;
  const all = await db.listVideos();
  if (token !== libPaint || !libShell?.stage.isConnected) return;
  const q = libQuery.trim().toLowerCase();
  let vids = all.filter((v) => !q || `${v.title} ${v.channel} ${(v.tags ?? []).map((t) => `#${t}`).join(' ')}`.toLowerCase().includes(q));
  if (libTags.size) vids = vids.filter((v) => [...libTags].every((t) => (v.tags ?? []).includes(t)));
  tagCounts = new Map();
  for (const v of all) for (const t of v.tags ?? []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  if (libSort === 'title') vids = [...vids].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (libSort === 'channel') vids = [...vids].sort((a, b) => (a.channel || '').localeCompare(b.channel || '') || b.updatedAt - a.updatedAt);
  const pinned = vids.filter((v) => v.pinned);
  const rest = vids.filter((v) => !v.pinned);
  const section = (title, list) => el('section', { class: 'lib-section' },
    title ? el('h2', { class: 'lib-title' }, title) : null,
    el('div', { class: 'grid' }, list.map(videoCard)));
  const grouped = (list, fallbackTitle) => {
    if (libGroup === 'none') return list.length ? section(fallbackTitle, list) : null;
    const by = new Map();
    const keysOf = (v) => (libGroup === 'tag' ? (v.tags?.length ? v.tags.map((t) => `#${t}`) : ['Untagged']) : [v.channel || 'Unknown channel']);
    for (const v of list) for (const k of keysOf(v)) { if (!by.has(k)) by.set(k, []); by.get(k).push(v); }
    return el('div', {}, [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, l]) => section(k, l)));
  };
  let body;
  if (!all.length) {
    body = el('div', { class: 'empty' },
      el('p', {}, 'No videos yet.'),
      el('p', { class: 'hint' }, 'Open a YouTube video — the transcript panel saves everything here.'));
  } else if (!vids.length) {
    body = el('div', { class: 'empty' }, el('p', {}, 'Nothing matches.'));
  } else {
    body = el('div', {},
      pinned.length ? section('Pinned', pinned) : null,
      grouped(rest, pinned.length ? 'Everything else' : null));
  }
  libShell.count.textContent = `${all.length} videos`;
  swapBody(body, transition);
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

// Card = link + an action row that lives outside the <a> (no nested interactives).
function videoCard(v) {
  const wrap = el('div', { class: 'card-wrap' });
  const del = el('button', {
    class: 'card-del icon-btn', title: 'Delete', 'aria-label': `Delete ${v.title || v.videoId}`,
    onclick: () => {
      const box = confirmBox({
        text: `Delete "${v.title || v.videoId}" from the library? Files in the knowledge base stay.`,
        onCancel: () => box.remove(),
        onConfirm: async () => { await db.deleteVideo(v.videoId); renderLibrary(); },
      });
      box.classList.add('card-confirm');
      wrap.append(box);
    },
  }, trashIcon());
  const pin = el('button', {
    class: `card-pin icon-btn pin${v.pinned ? ' on' : ''}`, title: v.pinned ? 'Unpin' : 'Pin', 'aria-label': v.pinned ? 'Unpin' : 'Pin', 'aria-pressed': v.pinned ? 'true' : 'false',
    onclick: async () => {
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
  wrap.classList.add('card');
  wrap.append(
    el('a', { class: 'card-link', href: `#/video/${v.videoId}` },
      el('div', { class: 'card-title' }, v.title || v.videoId),
      el('div', { class: 'card-meta' }, [v.channel, relTime(v.updatedAt)].filter(Boolean).join(' · '))),
    videoTagEditor(v).root,
    el('div', { class: 'card-badges' },
      `${v.counts.segments} segments · ${v.counts.messages} messages · ${v.counts.cards} notes`),
    el('div', { class: 'card-actions' }, pin, del));
  return wrap;
}

// Tag row on a card (and the detail head): chips + "+" → compact editor popover; saves in place, no repaint.
let allTagsCache = null;
const allTags = async () => (allTagsCache ??= [...new Set((await db.listVideos()).flatMap((x) => x.tags ?? []))].sort());
function videoTagEditor(v) {
  const ed = createTagEditor({
    compact: true,
    get: () => v.tags ?? [],
    set: async (tags) => {
      v.tags = tags;
      ed.refresh();
      allTagsCache = null;
      const video = v.chats ? v : await db.getVideo(v.videoId); // a full record (detail) or a listVideos row (card)
      if (!video) return;
      video.tags = tags;
      video.kept = true;
      await db.saveVideo(video);
      db.getSettings().then((st) => vault.syncTags(st, video)).catch((err) => toast(`Knowledge base: ${err.message}`));
      tagCounts = new Map();
      for (const x of await db.listVideos()) for (const t of x.tags ?? []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      allTags().then(() => ed.refresh()).catch(() => {});
    },
    suggest: () => allTagsCache ?? [],
  });
  allTags().then(() => ed.refresh()).catch(() => {});
  ed.root.classList.add('card-tags');
  return ed;
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

  const tagEditor = videoTagEditor(video);
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
    el('a', { class: 'icon-btn', href: '#/', title: 'Library', 'aria-label': 'Back to library' }, chevronLeft()),
    el('div', { class: 'detail-head' },
      el('a', { class: 'detail-title', href: video.url, target: '_blank' }, video.title || video.videoId),
      el('div', { class: 'detail-meta' }, video.channel || ''),
      tagEditor.root),
    pinBtn);

  const pane = el('div', { class: 'pane' });
  const panes = { Transcript: transcriptPane, Chat: chatPane, Notes: notesPane };
  const seg = el('div', { class: 'segmented', role: 'tablist' }, Object.keys(panes).map((name) =>
    el('button', { class: 'seg-btn', role: 'tab', dataset: { tab: name } }, name)));
  const built = {}; // cache pane instances so chat busy-state and in-flight requests survive tab switches
  function show(name) {
    for (const b of seg.children) { b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'); }
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
    } else if (hk === 'focusChat') {
      show('Chat'); built.Chat?.__focus?.();
    } else if (hk === 'findTranscript') {
      show('Transcript'); built.Transcript?.querySelector?.('.tr-search')?.focus();
    } else if (hk === 'newNote' || hk === 'quickNote') {
      show('Notes'); built.Notes?.__view?.addNote(hk === 'quickNote' ? 'quick' : 'note');
    } else if (hk === 'toggleNote') {
      show('Notes'); built.Notes?.__view?.toggle();
    } else if (hk === 'prevNote' || hk === 'nextNote') {
      show('Notes'); built.Notes?.__view?.move(hk === 'nextNote' ? 1 : -1);
    } else if (hk === 'focusVideo') {
      // no player on the library page
    } else {
      show('Notes');
      built.Notes?.__view?.setMode(hk === 'editMode' ? 'edit' : 'view');
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

function transcriptPane(video, disk) {
  const grouped = video.transcript?.grouped ?? [];
  const root = el('div', { class: 'tr' });
  if (!grouped.length) {
    const fetchBtn = el('button', { class: 'btn primary' }, 'Fetch transcript');
    fetchBtn.onclick = async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Fetching…';
      try {
        const s = await db.getSettings();
        const t = await transcriptLib.fetchTranscript(video.videoId, { lang: s.lang || 'en' });
        video.transcript = { lang: t.lang, trackName: t.trackName, track: t.track, translate: null, tracks: t.tracks, duration: t.duration, chapters: t.chapters, grouped: transcriptLib.groupSegments(t.segments) };
        if (!vault.hasTitle(video) && vault.cleanTitle(t.title)) video.title = vault.cleanTitle(t.title);
        if (!video.channel && t.channel) video.channel = t.channel;
        await db.saveVideo(video);
        disk((st) => vault.syncTranscript(st, video));
        root.replaceWith(transcriptPane(video, disk));
      } catch (err) {
        toast(transcriptLib.explainFailure(err));
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch transcript';
      }
    };
    root.append(el('div', { class: 'empty' }, el('p', {}, 'No transcript saved for this video.'), fetchBtn));
    return root;
  }
  const rows = [];
  const search = el('input', { class: 'input tr-search', type: 'search', placeholder: 'Search transcript…', 'aria-label': 'Search transcript' });
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) {
      const hit = !q || r.text.toLowerCase().includes(q);
      r.el.hidden = !hit;
      highlight(r.body, r.text, hit ? q : '');
    }
    for (const c of root.querySelectorAll('.tr-chapter')) c.hidden = !!q;
  };
  search.onkeydown = (e) => { if (!e.altKey) e.stopPropagation(); };
  const copyAll = el('button', { class: 'btn', onclick: () => {
    navigator.clipboard.writeText(grouped.map((g) => `[${fmtTime(g.start)}] ${g.text}`).join('\n')).then(() => toast('Transcript copied'), () => toast('Copy failed'));
  } }, 'Copy all');
  const meta = el('span', { class: 'tr-meta' }, [video.transcript.trackName, video.transcript.duration ? fmtTime(video.transcript.duration) : null].filter(Boolean).join(' · '));
  root.append(el('div', { class: 'tr-tools' }, search, meta, copyAll));
  const list = el('div', { class: 'seg-list' });
  const chapters = video.transcript.chapters ?? [];
  let ci = 0;
  for (const seg of grouped) {
    while (ci < chapters.length && chapters[ci].start <= seg.start) {
      const c = chapters[ci++];
      list.append(el('a', { class: 'tr-chapter', href: atTimeUrl(video.url, c.start), target: '_blank' }, el('span', { class: 'chip time' }, fmtTime(c.start)), el('span', { class: 'tr-chapter-title' }, c.title)));
    }
    // ponytail: a <button> inside the row <a> — invalid-ish HTML, but preventDefault keeps the link inert and it
    // keeps the copy affordance inline at the end of the text instead of floating over it.
    const copy = el('button', { class: 'seg-copy icon-btn', title: 'Copy line', 'aria-label': 'Copy line', onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.writeText(`[${fmtTime(seg.start)}] ${seg.text}`).then(() => toast('Copied'), () => toast('Copy failed'));
    } }, copyIcon());
    const body = el('span', { class: 'seg-body' }, seg.text);
    const row = el('a', { class: 'seg', href: atTimeUrl(video.url, seg.start), target: '_blank' },
      el('span', { class: 'chip time' }, fmtTime(seg.start)),
      el('span', { class: 'seg-text' }, body, copy));
    rows.push({ el: row, body, text: seg.text });
    list.append(row);
  }
  root.append(list);
  return root;
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
    onUndo: (card, idx) => toast('Deleted', { action: { label: 'Undo', onClick: () => {
      video.notes.cards.splice(Math.min(idx, video.notes.cards.length), 0, card);
      dirty.add(card); flush(); view.refresh();
    } } }),
  });
  // ponytail: no "@ time" stamp button here — the library page has no playing video to read time from.
  const root = el('div', { class: 'notes' }, view.root);
  root.__view = view; // hotkeys reach the editor through the cached pane
  return root;
}

// ---------- settings ----------

async function renderSettings() {
  const s = await db.getSettings();

  const keyField = (value) => {
    const input = el('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false' });
    input.value = value;
    const eye = el('button', { class: 'btn key-eye', type: 'button', 'aria-label': 'Show key', onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.textContent = input.type === 'password' ? 'Show' : 'Hide';
    } }, 'Show');
    const status = el('span', { class: 'key-status' }, value ? '● key set' : '○ no key');
    input.addEventListener('input', () => { status.textContent = input.value.trim() ? '● key set' : '○ no key'; status.classList.remove('ok', 'bad'); });
    return { input, row: el('div', { class: 'field-row' }, input, eye), status };
  };
  const ak = keyField(s.anthropicKey);
  const ok = keyField(s.openaiKey);
  const anthropicKey = ak.input;
  const openaiKey = ok.input;
  const theme = el('div', { class: 'segmented' }, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
    el('button', { class: `seg-btn${(s.theme || 'auto') === v ? ' active' : ''}`, type: 'button', dataset: { v }, onclick: () => {
      for (const b of theme.children) b.classList.toggle('active', b.dataset.v === v);
      applyTheme(v);
      syncSave();
    } }, l)));
  const themeValue = () => theme.querySelector('.active')?.dataset.v || 'auto';
  const lang = el('input', { class: 'input', placeholder: 'en', maxlength: '5' });
  lang.value = s.lang || 'en';
  const prompts = el('textarea', { class: 'input mono', rows: 6, spellcheck: 'false', placeholder: promptsToText(PROMPTS) });
  prompts.value = s.prompts ?? promptsToText(PROMPTS);
  const resetPrompts = el('button', { class: 'btn', type: 'button', onclick: () => { prompts.value = promptsToText(PROMPTS); syncSave(); } }, 'Reset to defaults');
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
    theme: themeValue(),
    lang: lang.value.trim().toLowerCase() || 'en',
    prompts: prompts.value,
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
  const isDirty = () => JSON.stringify(formValues()) !== saved;
  const syncSave = () => { saveBtn.disabled = !isDirty(); };
  for (const f of [anthropicKey, openaiKey, aboutMe, tone, vaultDir, lang, prompts]) f.addEventListener('input', syncSave);
  hotkeys.addEventListener('change', syncSave);
  syncSave();
  // Leaving with unsaved edits saves them (nothing here is dangerous to persist).
  leaveSettings = async () => { if (isDirty()) { await db.saveSettings(formValues()); await db.clearCachedModels(); toast('Settings saved'); } };

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
        const st = provider === 'anthropic' ? ak.status : ok.status;
        st.textContent = '✓ key works'; st.classList.add('ok');
      } catch (err) {
        toast(`Test failed: ${err.message}`);
        const st = provider === 'anthropic' ? ak.status : ok.status;
        st.textContent = `✗ ${err.message}`; st.classList.add('bad');
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
      el('a', { class: 'icon-btn', href: '#/', title: 'Library', 'aria-label': 'Back to library' }, chevronLeft()),
      el('h1', {}, 'Settings')),
    el('div', { class: 'settings-form' },
      field('Anthropic API key', ak.row, el('span', {}, ak.status, ' · Model and thinking effort are picked in the chat composer.')),
      field('OpenAI API key', ok.row, ok.status),
      field('Appearance', theme, 'Library page theme. The YouTube panel follows YouTube.'),
      field('Caption language', lang, 'Preferred transcript language (e.g. en, ro, nl). Other tracks and translations are in the transcript toolbar.'),
      field('About me', aboutMe, 'Added to every chat system prompt so answers fit you.'),
      field('Chat presets', el('div', { class: 'field-col' }, prompts, resetPrompts), 'One per line as "Label: prompt". Shown as chips while a chat is empty; leave empty for none.'),
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
let leaveSettings = null; // installed by renderSettings: flushes unsaved edits on navigation
document.addEventListener('keydown', (e) => { if (detailKeys) detailKeys(e); });

async function route() {
  detailKeys = null;
  if (leaveSettings) { const f = leaveSettings; leaveSettings = null; await f().catch(() => {}); }
  const hash = location.hash || '#/';
  const p = hash.startsWith('#/video/') ? renderDetail(hash.slice('#/video/'.length))
    : hash === '#/settings' ? renderSettings()
    : renderLibrary();
  p.catch((err) => $app.replaceChildren(el('div', { class: 'empty' },
    el('p', {}, `Error: ${err.message}`),
    el('button', { class: 'btn', onclick: route }, 'Retry'))));
}

window.addEventListener('hashchange', route);
route();
