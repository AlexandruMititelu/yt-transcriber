// Tag editor. Full form (panel popover): selected chips with ✕, an input that filters the known tags and
// creates new ones (Enter / comma), the known tags as toggle chips. Compact form (library cards + detail,
// note footers): a chip row + a "+" that expands into that same input + list in a small popover.
// Spaces are refused (Obsidian tags have none). Classes ytx-tags-*; colors from host tokens.
// createTagEditor({ get, set, suggest?, compact?, chips?, locked?, up? }) → { root, refresh, focus, close }
// locked() = tags inherited from the parent: shown first, no ✕, cannot be toggled here. up = popover opens upward.
import { normTag, validTag, tagHue } from '../lib/tags.js';
import { plusIcon } from './icons.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A coloured #tag chip. opts: { on, count, onClick, x (remove handler) }
export function tagChip(tag, { on = false, count, onClick, x } = {}) {
  const chip = h(onClick ? 'button' : 'span', `ytx-tag${on ? ' is-on' : ''}`, tag); // bare name, no #
  chip.style.setProperty('--tag-h', tagHue(tag));
  chip.dataset.tag = tag;
  if (onClick) { chip.type = 'button'; chip.setAttribute('aria-pressed', on ? 'true' : 'false'); chip.addEventListener('click', (e) => { e.stopPropagation(); onClick(tag); }); }
  if (count != null) chip.append(' ', h('span', 'ytx-tag-n', String(count)));
  if (x) {
    const b = h('button', 'ytx-tag-x', '✕');
    b.type = 'button';
    b.title = `Remove ${tag}`;
    b.setAttribute('aria-label', `Remove ${tag}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); x(tag); });
    chip.append(b);
  }
  return chip;
}

export function createTagEditor({ get, set, suggest, compact = false, chips: showChips = true, locked, up = false }) {
  const root = h('div', compact ? 'ytx-tags ytx-tags-inline' : 'ytx-tags');
  const chips = h('div', 'ytx-tags-chips');
  const input = h('input', 'ytx-tags-input');
  input.type = 'text';
  input.placeholder = 'Find or add tag…';
  input.setAttribute('aria-label', 'Find or add tag');
  input.autocomplete = 'off';
  const known = h('div', 'ytx-tags-known');
  const panel = h('div', compact ? `ytx-tags-pop${up ? ' is-up' : ''}` : 'ytx-tags-panel');
  const inherited = h('div', 'ytx-tags-inherited');
  panel.append(inherited, input, known);
  let plus = null;
  if (compact) {
    plus = h('button', 'ytx-tags-plus');
    plus.appendChild(plusIcon()); // SVG: a text '+' sits off-centre in the circle
    plus.type = 'button';
    plus.title = 'Add tag';
    plus.setAttribute('aria-label', 'Add tag');
    plus.setAttribute('aria-expanded', 'false');
    plus.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); panel.classList.contains('is-open') ? close() : open(); });
    root.append(...(showChips ? [chips] : []), plus, panel);
  } else {
    root.append(chips, panel);
  }

  const onDown = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  // The popover is position: fixed at the "+" so scrolling containers (notes list, panel) can't clip it.
  let openedAt = 0;
  const onScroll = (e) => { if (Date.now() - openedAt > 400 && !panel.contains(e.target)) close(); };
  function place() {
    if (!plus) return;
    const r = plus.getBoundingClientRect();
    const w = panel.offsetWidth || 260;
    const hgt = panel.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const above = up || r.bottom + 6 + hgt > window.innerHeight - 8;
    panel.style.left = `${left}px`;
    panel.style.top = above ? `${Math.max(8, r.top - 6 - hgt)}px` : `${r.bottom + 6}px`;
  }
  function open() {
    input.value = '';
    refresh();
    panel.classList.add('is-open');
    openedAt = Date.now();
    place();
    plus?.setAttribute('aria-expanded', 'true');
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    input.focus();
  }
  function close() {
    if (!compact) return;
    panel.classList.remove('is-open');
    plus?.setAttribute('aria-expanded', 'false');
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  const toggle = (t) => set(get().includes(t) ? get().filter((v) => v !== t) : [...get(), t]);
  const remove = (t) => set(get().filter((v) => v !== t));
  const lockChip = (t) => { const c = tagChip(t, { on: true }); c.classList.add('is-locked'); c.title = 'From the video: remove it there'; return c; };
  // Selected chip = a button (Enter / Alt+Backspace removes) with a ✕ glyph, so arrows can land on it.
  const selChip = (t) => { const c = tagChip(t, { on: true, onClick: remove }); c.classList.add('is-sel'); c.title = `Remove ${t}`; c.append(h('span', 'ytx-tag-x', '✕')); return c; };
  function refresh() {
    const lk = locked?.() ?? [];
    const was = document.activeElement?.closest?.('.ytx-tag')?.dataset.tag; // keep the keyboard cursor on the same tag
    chips.textContent = '';
    for (const t of lk) chips.append(lockChip(t));
    for (const t of get().filter((t) => !lk.includes(t))) chips.append(selChip(t));
    inherited.textContent = '';
    inherited.hidden = !lk.length;
    if (lk.length) { inherited.append(h('span', 'ytx-tags-inherited-label', 'From the video')); for (const t of lk) inherited.append(lockChip(t)); }
    known.textContent = '';
    const q = normTag(input.value);
    const have = new Set(get());
    // Below the input: only tags not yet on this item (the selected ones sit above with ✕).
    const all = [...new Set(suggest?.() ?? [])].filter((t) => !lk.includes(t)).sort();
    for (const t of all.filter((t) => !have.has(t) && (!q || t.includes(q)))) known.append(tagChip(t, { onClick: toggle }));
    if (q && validTag(q) && !all.includes(q) && !lk.includes(q) && !have.has(q)) known.append(newChip(q));
    if (!known.childElementCount) known.append(h('div', 'ytx-tags-empty', q ? (have.has(q) ? 'Already added.' : 'Keep typing…') : (all.length ? 'All known tags are on it.' : 'No tags yet. Type one.')));
    if (was && root.contains(document.activeElement) === false) (root.querySelector(`.ytx-tag[data-tag="${CSS.escape(was)}"]:not(.is-locked)`) ?? input).focus();
  }
  // Keyboard: arrows walk input → known tags → selected tags (wrapping); Enter presses a chip; Alt+Backspace
  // removes a selected one; Alt+Enter closes (compact) and returns to the "+".
  const focusables = () => [input, ...known.querySelectorAll('.ytx-tag'), ...chips.querySelectorAll('.ytx-tag:not(.is-locked)')].filter((n) => n.isConnected && n.offsetParent !== null);
  // → true when the key was consumed. Called from the root (chips) and from the input's own handler
  // (which stops propagation for everything else, so arrows must be handled before that).
  function nav(e) {
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); e.stopPropagation(); close(); (plus ?? input).focus(); return true; }
    const list = focusables();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return false;
    const onInput = document.activeElement === input;
    const fwd = e.key === 'ArrowDown' || (e.key === 'ArrowRight' && !onInput);
    const back = e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && !onInput);
    if (fwd || back) { e.preventDefault(); e.stopPropagation(); list[(i + (fwd ? 1 : list.length - 1)) % list.length].focus(); return true; }
    if (e.key === 'Backspace' && e.altKey && document.activeElement.classList.contains('is-sel')) { e.preventDefault(); e.stopPropagation(); document.activeElement.click(); return true; }
    return false;
  }
  root.addEventListener('keydown', (e) => { if (e.target !== input) nav(e); });
  function newChip(q) {
    const c = tagChip(q, { onClick: () => add() });
    c.classList.add('is-new');
    c.prepend('+ ');
    return c;
  }
  function add() {
    if (/\s/.test(input.value)) { flag(); return; }
    const t = normTag(input.value);
    if (!validTag(t)) { if (input.value) flag(); return; }
    input.value = '';
    if (!get().includes(t)) set([...get(), t]);
    else refresh();
  }
  let flagT = 0;
  function flag() {
    input.classList.add('is-bad');
    clearTimeout(flagT);
    flagT = setTimeout(() => input.classList.remove('is-bad'), 600);
  }
  input.addEventListener('keydown', (e) => {
    if (nav(e)) return;
    if (e.key === ' ') { e.preventDefault(); flag(); return; } // no spaces in tags
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); return; }
    if (e.key === 'Backspace' && !input.value && get().length) { e.preventDefault(); set(get().slice(0, -1)); return; }
    if (!e.altKey) e.stopPropagation(); // host hotkeys stay out of the field
  });
  input.addEventListener('input', () => { if (/\s/.test(input.value)) { input.value = input.value.replace(/\s+/g, ''); flag(); } refresh(); });
  refresh();
  return { root, refresh, focus: () => input.focus(), close };
}
