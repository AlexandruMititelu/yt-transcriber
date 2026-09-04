// Notes tab — shared by the YouTube panel and the library page. Two kinds of card:
//   quick  ≤280 chars, always fully visible, markdown renders when the cursor leaves
//   note   long-form markdown document with a title; opens the editor in place of the list
// Classes are unique (ytx-notes-*, ytx-qn-*, ytx-nt-*, ytx-ed-*) so this loads unscoped on youtube.com.
import { confirmBox } from './chatbar.js';
import { trashIcon, chevronLeft, eyeIcon, cameraIcon } from './icons.js';
import { keysFor } from '../../config/hotkeys.js';
import * as db from '../lib/db.js';

export const QUICK_MAX = 280;
export const HELP = {
  quick: `Quick note: up to ${QUICK_MAX} characters, always shown in full on the card. Markdown renders when you click away.`,
  note: 'Note: a full markdown document with a title. Opens in the editor; the card shows only the title and first sentence.',
};

import { extractTags, chipTags } from '../lib/tags.js';
import { tagChip, createTagEditor } from './tags.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };

let editorMode = 'edit'; // 'edit' (raw markdown) | 'view' (rendered, type directly); persisted in settings.noteMode
db.getSettings().then((s) => { if (s.noteMode === 'view' || s.noteMode === 'edit') editorMode = s.noteMode; }).catch(() => {});
const COLOR_NAMES = ['None', 'Yellow', 'Green', 'Blue', 'Pink'];

// Rendered HTML (contenteditable) → markdown. Covers what marked produces for everyday notes.
// ponytail: headings, emphasis, code, lists, quotes, links, hr; anything exotic degrades to text.
export function htmlToMd(root) {
  const walk = (node, ctx = {}) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = () => [...node.childNodes].map((n) => walk(n, ctx)).join('');
    if (node.classList.contains('ytx-ts') || node.classList.contains('time')) return `@${node.textContent.trim()}`;
    switch (tag) {
      case 'br': return '\n';
      case 'hr': return '\n---\n\n';
      case 'strong': case 'b': return `**${inner()}**`;
      case 'em': case 'i': return `*${inner()}*`;
      case 'del': case 's': return `~~${inner()}~~`;
      case 'code': return node.parentElement?.tagName === 'PRE' ? inner() : `\`${inner()}\``;
      case 'pre': return `\n\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'a': return node.href ? `[${inner()}](${node.getAttribute('href')})` : inner();
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n${'#'.repeat(+tag[1])} ${inner().trim()}\n\n`;
      case 'p': case 'div': return `\n${inner().trim()}\n\n`;
      case 'blockquote': return `\n${inner().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'ul': case 'ol': {
        const items = [...node.children].filter((c) => c.tagName === 'LI').map((li, i) => {
          const body = walk(li, { list: tag }).trim().replace(/\n/g, '\n  ');
          return `${tag === 'ol' ? `${i + 1}.` : '-'} ${body}`;
        });
        return `\n${items.join('\n')}\n\n`;
      }
      case 'li': return inner();
      default: return inner();
    }
  };
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

// First sentence of a markdown body, syntax stripped, ≤ QUICK_MAX chars.
export function excerpt(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(plain);
  const first = m ? m[1] : plain;
  return first.length > QUICK_MAX ? `${first.slice(0, QUICK_MAX - 1)}…` : first;
}

// Timestamp text conventions inside notes: `@now` → current video time; `@2:17` → `@02:17` (mm:ss, or h:mm:ss).
export function stampFmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}
// @now → @mm:ss. With a transcript lookup `at(sec)` (transcript.transcriptAt): @now=t adds the caption line
// being spoken, @now=tt the previous / current / next lines as a quote, @now=ttt the whole timestamp block.
export function normalizeStamps(text, nowSec, at) {
  let out = String(text);
  if (nowSec != null) {
    out = out.replace(/@now(=t{1,3})?(?![\w=])/gi, (_, lvl) => {
      const stamp = `@${stampFmt(nowSec)}`;
      const t = lvl ? at?.(nowSec) : null;
      if (!t) return stamp;
      const n = lvl.length - 1;
      if (n === 1) return `${stamp} "${t.line}"`;
      if (n === 2) return `${stamp}\n> ${[t.prev, `**${t.line}**`, t.next].filter(Boolean).join('\n> ')}`;
      return `${stamp}\n> [${stampFmt(t.blockStart)}] ${t.block}`;
    });
  }
  return out.replace(/@(\d{1,2}):(\d{2})(?![:\d])/g, (_, m, s) => `@${m.padStart(2, '0')}:${s}`);
}

export function newCard(kind) {
  return { id: crypto.randomUUID(), kind, title: '', text: '', start: null, color: 0, ts: Date.now() };
}

// opts: { video, renderMd(text) → element, onChange(card), onDelete(card), fmtTime(sec),
//         currentTime?() → sec | null, transcriptAt?(sec) (for @now=t/tt/ttt), onSeek?(sec), timeHref?(sec) }
// → { root, refresh(), flush() }
export function createNotesView(opts) {
  const { video, renderMd, onChange, onDelete, fmtTime } = opts;
  const root = h('div', 'ytx-notes');
  let openId = null; // note being edited; null = list
  let selId = null; // list selection (card id); persists across refresh(), moves off a deleted card
  let cardEls = new Map(); // id → current list card element (rebuilt on every list paint)
  let query = '';
  let newestFirst = false;
  let tagFilter = null; // inline #tag chosen in the filter row

  // Cards in current filter/sort order (same rules paint() renders with).
  const displayCards = () => {
    const q = query.trim().toLowerCase();
    let cards = video.notes.cards.filter((c) => !q || `${c.title || ''}\n${c.text || ''}`.toLowerCase().includes(q));
    if (tagFilter) cards = cards.filter((c) => extractTags(c.text).includes(tagFilter));
    if (newestFirst) cards = [...cards].reverse();
    return cards;
  };
  // Per-note tags = inline #tags in the text. The footer "+" adds ` #tag` at the end / strips a removed one.
  const noteTagEditor = (card, after) => createTagEditor({
    compact: true,
    chips: false,
    up: true,
    locked: () => video.tags ?? [],
    get: () => extractTags(card.text),
    set: (tags) => {
      const cur = extractTags(card.text);
      let text = card.text || '';
      for (const t of cur.filter((t) => !tags.includes(t))) text = text.replace(new RegExp(`(^|\\s)#${t.replace(/[/-]/g, '\\$&')}(?![\\p{L}\\p{N}_/-])`, 'gu'), '$1').replace(/[ \t]+$/gm, '');
      for (const t of tags.filter((t) => !cur.includes(t))) text = `${text.replace(/\s+$/, '')}${text.trim() ? ' ' : ''}#${t}`;
      card.text = text;
      onChange(card);
      after();
    },
    suggest: () => [...new Set(video.notes.cards.flatMap((c) => extractTags(c.text)))].sort(),
  });
  const markSelected = () => cardEls.forEach((el, id) => el.classList.toggle('is-selected', id === selId));
  // Select a card by id (null clears). Re-applies the highlight, scrolls it into view and focuses it
  // (unless focus is already inside it, e.g. its own textarea was just clicked into).
  function select(id) {
    selId = id ?? null;
    markSelected();
    const el = selId != null ? cardEls.get(selId) : null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (!el.contains(document.activeElement)) el.focus();
  }
  const selectedId = () => selId;
  // Move the selection by +1/-1 through the visible cards, wrapping. Closes the editor first.
  function move(dir) {
    if (openId) { flush(); openId = null; refresh(); }
    const cards = displayCards();
    if (!cards.length) return;
    let idx = cards.findIndex((c) => c.id === selId);
    idx = idx === -1 ? (dir > 0 ? 0 : cards.length - 1) : (idx + dir + cards.length) % cards.length;
    select(cards[idx].id);
  }
  // Editor open → close it and select that card. Else open/edit the selected card, or select the first.
  function toggle() {
    if (openId) {
      const id = openId;
      flush();
      openId = null;
      refresh();
      select(id);
      return;
    }
    const card = selId != null ? video.notes.cards.find((c) => c.id === selId) : null;
    if (card) {
      if (card.kind === 'note') { openId = card.id; refresh(); return; }
      cardEls.get(card.id)?.querySelector('.ytx-qn-body')?.click(); // reuse mdField's click-to-edit
      return;
    }
    const cards = displayCards();
    if (cards.length) select(cards[0].id);
  }

  /* ---- shared bits ---- */
  function timeSlot(card, onRerender) {
    const wrap = h('span', 'ytx-notes-time');
    const draw = () => {
      wrap.textContent = '';
      if (card.start == null) {
        const at = h('button', 'ytx-notes-chip-btn', '@ time');
        at.type = 'button';
        at.title = opts.currentTime ? 'Stamp current video time' : 'Set a timestamp (m:ss)';
        at.addEventListener('click', (e) => {
          e.stopPropagation();
          if (opts.currentTime) card.start = opts.currentTime() ?? 0;
          else {
            const v = window.prompt('Timestamp (m:ss or h:mm:ss)', '');
            if (!v || !/^\d{1,3}(:[0-5]?\d){1,2}$/.test(v.trim())) return;
            card.start = v.trim().split(':').reduce((a, p) => a * 60 + Number(p), 0);
          }
          onChange(card);
          draw();
          if (onRerender) onRerender();
        });
        wrap.appendChild(at);
        return;
      }
      let chip;
      if (opts.onSeek) {
        chip = h('button', 'ytx-notes-chip', fmtTime(card.start));
        chip.type = 'button';
        chip.addEventListener('click', (e) => { e.stopPropagation(); opts.onSeek(card.start); });
      } else {
        chip = h('a', 'ytx-notes-chip', fmtTime(card.start));
        chip.href = opts.timeHref ? opts.timeHref(card.start) : '#';
        chip.target = '_blank';
        chip.addEventListener('click', (e) => e.stopPropagation());
      }
      const x = h('button', 'ytx-notes-chip-x', '✕');
      x.type = 'button';
      x.title = 'Clear timestamp';
      x.addEventListener('click', (e) => { e.stopPropagation(); card.start = null; onChange(card); draw(); if (onRerender) onRerender(); });
      wrap.append(chip, x);
    };
    draw();
    return wrap;
  }

  function delBtn(card, host, restore) {
    const b = h('button', 'ytx-notes-icon ytx-notes-del');
    b.appendChild(trashIcon());
    b.type = 'button';
    b.title = card.kind === 'note' ? 'Delete note' : 'Delete quick note';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // Overlay on the card (content stays visible behind it) rather than replacing it.
      const box = confirmBox({
        text: card.kind === 'note' ? `Delete "${card.title || 'Untitled'}"?` : 'Delete this quick note?',
        onCancel: () => box.remove(),
        onConfirm: () => {
          const idx = video.notes.cards.indexOf(card);
          const shown = selId === card.id ? displayCards() : null; // display order before removal
          video.notes.cards = video.notes.cards.filter((c) => c.id !== card.id);
          if (openId === card.id) openId = null;
          if (shown) {
            const pos = shown.findIndex((c) => c.id === card.id);
            selId = shown[pos + 1]?.id ?? shown[pos - 1]?.id ?? null;
          }
          onDelete(card);
          refresh();
          if (opts.onUndo) opts.onUndo(card, idx);
        },
      });
      box.classList.add('ytx-notes-overlay');
      host.style.position = 'relative';
      host.append(box);
    });
    return b;
  }

  // Rendered markdown that turns into a textarea on click; back to rendered on blur.
  // With `wysiwyg`, the rendered HTML itself is contenteditable and is converted back to markdown.
  function mdField(card, { cls, placeholder, max, onInput, wysiwyg, always }) {
    const box = h('div', cls);
    const show = () => {
      if (always && !(wysiwyg && wysiwyg())) { edit(); return; }
      box.textContent = '';
      box.classList.remove('is-editing');
      if (wysiwyg && wysiwyg()) {
        const md = card.text.trim() ? renderMd(card.text) : h('div', 'ytx-md');
        md.contentEditable = 'true';
        md.setAttribute('data-placeholder', placeholder);
        md.addEventListener('input', () => {
          card.text = normalizeStamps(htmlToMd(md), opts.currentTime ? opts.currentTime() : null, opts.transcriptAt);
          onChange(card);
          if (onInput) onInput();
        });
        md.addEventListener('keydown', (e) => e.stopPropagation());
        md.addEventListener('blur', show); // normalize: re-render from the markdown we stored
        box.appendChild(md);
        return;
      }
      if (card.text.trim()) { const md = renderMd(card.text); chipTags(md, (t) => { tagFilter = tagFilter === t ? null : t; refresh(); }); box.appendChild(md); }
      else box.appendChild(h('div', 'ytx-notes-placeholder', placeholder));
    };
    const edit = () => {
      box.textContent = '';
      box.classList.add('is-editing');
      const ta = h('textarea', 'ytx-notes-ta');
      ta.placeholder = placeholder;
      ta.value = card.text;
      if (max) ta.maxLength = max;
      const counter = max ? h('div', 'ytx-notes-count') : null;
      const tick = () => {
        if (counter) {
          counter.textContent = `${ta.value.length}/${max}`;
          counter.classList.toggle('is-near', ta.value.length >= max * 0.9 && ta.value.length < max);
          counter.classList.toggle('is-full', ta.value.length >= max);
        }
        if (!always) autosize(ta);
      };
      ta.addEventListener('input', () => {
        const before = ta.value;
        const fixed = normalizeStamps(before, opts.currentTime ? opts.currentTime() : null, opts.transcriptAt);
        if (fixed !== before) {
          const caret = ta.selectionStart + (fixed.length - before.length);
          ta.value = fixed;
          ta.selectionStart = ta.selectionEnd = caret;
        }
        card.text = max ? ta.value.slice(0, max) : ta.value;
        tick();
        onChange(card);
        if (onInput) onInput();
      });
      ta.addEventListener('keydown', (e) => { if (!e.altKey) e.stopPropagation(); }); // keep YouTube hotkeys out, let Alt+ ones through
      if (!always) ta.addEventListener('blur', show);
      // Remember the caret so switching modes and back lands where the user was.
      const remember = () => { card._caret = ta.selectionStart; };
      ta.addEventListener('keyup', remember);
      ta.addEventListener('click', remember);
      ta.addEventListener('blur', remember);
      box.appendChild(ta);
      if (counter) box.appendChild(counter);
      tick();
      if (always && typeof card._caret === 'number') {
        const p = Math.min(card._caret, ta.value.length);
        ta.selectionStart = ta.selectionEnd = p;
      }
      if (!always) ta.focus();
      return ta;
    };
    box.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      if (box.classList.contains('is-editing') || (wysiwyg && wysiwyg())) {
        if (e.target === box) focusField(box, { end: true }); // padding / empty space below the text
        return;
      }
      edit();
    });
    show();
    return { box, edit, show };
  }

  // Focus the editable in `box`. `end` moves the caret to the end (click on empty space below the
  // text); otherwise the caret stays where the field last had it (mode switch / hotkey).
  function focusField(box, { end = false } = {}) {
    const f = box.querySelector('textarea, [contenteditable="true"]');
    if (!f) return;
    if (document.activeElement === f) return; // already there: never move the caret
    f.focus();
    if (!end) return;
    if (f.tagName === 'TEXTAREA') f.selectionStart = f.selectionEnd = f.value.length;
    else {
      const r = document.createRange();
      r.selectNodeContents(f);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  /* ---- list ---- */
  function quickCard(card) {
    const el = h('div', `ytx-qn ytx-c${card.color || 0}`);
    el.tabIndex = 0;
    el.addEventListener('click', (e) => { if (!e.target.closest('a, button')) select(card.id); });
    const { box } = mdField(card, { cls: 'ytx-qn-body', placeholder: 'Quick note…', max: QUICK_MAX });
    const foot = h('div', 'ytx-notes-foot');
    const dot = h('button', 'ytx-notes-dot');
    dot.type = 'button';
    dot.title = 'Color';
    dot.setAttribute('aria-label', 'Card color');
    const swatches = h('div', 'ytx-notes-swatches');
    for (let i = 0; i < 5; i++) {
      const sw = h('button', `ytx-notes-swatch ytx-c${i}${(card.color || 0) === i ? ' is-on' : ''}`);
      sw.type = 'button';
      sw.title = COLOR_NAMES[i];
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        card.color = i;
        el.className = `ytx-qn ytx-c${i}`;
        swatches.querySelectorAll('.ytx-notes-swatch').forEach((x, j) => x.classList.toggle('is-on', j === i));
        swatches.classList.remove('is-open');
        onChange(card);
      });
      swatches.append(sw);
    }
    dot.addEventListener('click', (e) => { e.stopPropagation(); swatches.classList.toggle('is-open'); });
    const colorWrap = h('span', 'ytx-notes-color');
    colorWrap.append(dot, swatches);
    foot.append(timeSlot(card), colorWrap, noteTagEditor(card, () => el.replaceWith(quickCard(card))).root, delBtn(card, el, () => el.replaceWith(quickCard(card))));
    el.append(box, foot);
    return el;
  }

  function noteCard(card) {
    const el = h('div', 'ytx-nt');
    el.tabIndex = 0;
    el.title = 'Open in editor';
    el.append(h('div', 'ytx-nt-title', card.title || 'Untitled'), h('div', 'ytx-nt-excerpt', excerpt(card.text) || 'Empty note'));
    const foot = h('div', 'ytx-notes-foot');
    foot.append(timeSlot(card), h('span', 'ytx-notes-spacer'), noteTagEditor(card, () => el.replaceWith(noteCard(card))).root, delBtn(card, el, () => el.replaceWith(noteCard(card))));
    el.appendChild(foot);
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a, .ytx-confirm')) return;
      selId = card.id; // editor doesn't render the grid, so set directly rather than via select()
      openId = card.id;
      refresh();
    });
    return el;
  }

  // Camera: save the current frame to the vault and embed it (into `card`, or a fresh note when null).
  function frameBtn(card) {
    const b = h('button', 'ytx-notes-icon ytx-notes-cam');
    b.type = 'button';
    b.title = 'Save current frame into the knowledge base';
    b.setAttribute('aria-label', 'Save current frame');
    b.appendChild(cameraIcon());
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        const r = await opts.onFrame();
        if (!r) return;
        let target = card;
        if (!target) {
          target = newCard('note');
          target.title = `Frame at ${fmtTime(r.sec)}`;
          target.start = r.sec;
          video.notes.cards.push(target);
          openId = target.id;
        }
        target.text = `${target.text ? `${target.text}\n\n` : ''}@${stampFmt(r.sec)} ${r.embed}\n`;
        onChange(target);
        flush();
        refresh();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function renderList() {
    root.textContent = '';
    const bar = h('div', 'ytx-notes-bar');
    const addQuick = h('button', 'ytx-notes-btn', '+ quick note');
    addQuick.type = 'button';
    addQuick.title = HELP.quick;
    addQuick.addEventListener('click', () => addNote('quick'));
    const addNoteBtn = h('button', 'ytx-notes-btn is-note', '+ note');
    addNoteBtn.type = 'button';
    addNoteBtn.title = HELP.note;
    addNoteBtn.addEventListener('click', () => addNote('note'));
    bar.append(addQuick, addNoteBtn);
    if (opts.onFrame) bar.append(frameBtn(null));
    const all = video.notes.cards;
    if (all.length > 3) {
      const search = h('input', 'ytx-notes-search');
      search.type = 'search';
      search.placeholder = 'Filter…';
      search.setAttribute('aria-label', 'Filter notes');
      search.value = query;
      search.addEventListener('input', () => { query = search.value; paint(); });
      search.addEventListener('keydown', (e) => { if (!e.altKey) e.stopPropagation(); });
      const sort = h('button', 'ytx-notes-sort', newestFirst ? 'Newest' : 'Oldest');
      sort.type = 'button';
      sort.title = 'Sort order';
      sort.addEventListener('click', () => { newestFirst = !newestFirst; sort.textContent = newestFirst ? 'Newest' : 'Oldest'; paint(); });
      bar.append(h('span', 'ytx-notes-spacer'), search, sort);
    }
    // Filter row: every inline #tag across the notes, with counts; click toggles the filter.
    const tagRow = h('div', 'ytx-tag-row ytx-notes-tags');
    const counts = new Map();
    for (const c of all) for (const t of extractTags(c.text)) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      tagRow.append(tagChip(t, { on: tagFilter === t, count: n, onClick: () => { tagFilter = tagFilter === t ? null : t; refresh(); } }));
    }
    const grid = h('div', 'ytx-notes-grid');
    const paint = () => {
      grid.textContent = '';
      cardEls = new Map();
      const cards = displayCards();
      for (const card of cards) {
        const el = card.kind === 'note' ? noteCard(card) : quickCard(card);
        cardEls.set(card.id, el);
        grid.appendChild(el);
      }
      if (!all.length) {
        const empty = h('div', 'ytx-notes-empty');
        empty.append(h('div', 'ytx-notes-empty-title', 'No notes yet'),
          h('div', null, HELP.quick), h('div', null, HELP.note));
        grid.append(empty);
      } else if (!cards.length) grid.append(h('div', 'ytx-notes-empty', 'Nothing matches.'));
      markSelected();
    };
    paint();
    root.append(bar, tagRow, grid);
  }

  /* ---- editor ---- */
  function renderEditor(card) {
    root.textContent = '';
    const bar = h('div', 'ytx-ed-bar');
    const back = h('button', 'ytx-ed-back');
    back.appendChild(chevronLeft());
    back.append('Notes');
    back.type = 'button';
    back.title = 'Back to all notes';
    back.addEventListener('click', () => { openId = null; refresh(); });
    const title = h('input', 'ytx-ed-title');
    title.type = 'text';
    title.placeholder = 'Title';
    title.value = card.title || '';
    title.maxLength = 120;
    title.addEventListener('input', () => { card.title = title.value; onChange(card); });
    title.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); editorMode === 'edit' ? body.edit() : body.box.querySelector('[contenteditable]')?.focus(); }
    });
    const ed = h('div', 'ytx-ed');
    bar.append(back, title);
    const body = mdField(card, { cls: 'ytx-ed-body', placeholder: 'Write here…', wysiwyg: () => editorMode === 'view', always: true });
    const foot = h('div', 'ytx-notes-foot');
    // Mode toggle: edit = raw markdown textarea (stays a textarea, never flips on blur); view = type into the rendered note.
    const modes = h('span', 'ytx-ed-modes');
    const modeBtn = (key, glyph, tip) => {
      const b = h('button', `ytx-ed-mode${editorMode === key ? ' is-on' : ''}`);
      b.append(glyph);
      b.type = 'button';
      b.title = `${tip} (${keysFor(key === 'edit' ? 'editMode' : 'viewMode')})`;
      b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus: a blur re-render would swallow the click
      b.addEventListener('click', () => setMode(key));
      return b;
    };
    modes.append(
      modeBtn('edit', '</>', 'Edit mode: write raw markdown'),
      modeBtn('view', eyeIcon(), 'View mode: write directly into the rendered note'),
    );
    foot.append(timeSlot(card), h('span', 'ytx-notes-spacer'), noteTagEditor(card, () => refresh()).root, ...(opts.onFrame ? [frameBtn(card)] : []), modes, delBtn(card, ed, () => refresh()));
    ed.append(bar, body.box, foot);
    root.appendChild(ed);
    if (!card.title && !card.text) title.focus();
  }

  function refresh() {
    const open = openId && video.notes.cards.find((c) => c.id === openId);
    if (open) renderEditor(open);
    else { openId = null; renderList(); }
  }

  // Hotkeys call this; re-renders the open editor in the new mode and puts the caret in it.
  function setMode(mode) {
    if (mode !== editorMode) {
      flush();
      editorMode = mode;
      db.saveSettings({ noteMode: mode }).catch(() => {});
      if (openId) refresh();
    }
    const body = root.querySelector('.ytx-ed-body');
    if (body) focusField(body);
  }

  // Commit any textarea / editable still focused (called before teardown and mode switches).
  function flush() {
    const ta = root.querySelector('textarea, [contenteditable="true"]');
    if (ta) ta.blur();
  }

  function addNote(kind = 'note', text = '') {
    const c = newCard(kind);
    c.text = text;
    video.notes.cards.push(c);
    onChange(c);
    selId = c.id;
    if (kind === 'note') { openId = c.id; refresh(); return; }
    refresh();
    cardEls.get(c.id)?.querySelector('.ytx-qn-body')?.click();
  }

  refresh();
  return { root, refresh, flush, setMode, addNote, isEditing: () => !!openId, select, selectedId, move, toggle };
}
