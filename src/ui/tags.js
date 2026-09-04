// Tag editor. Full form (panel popover): selected chips with ✕, an input that filters the known tags and
// creates new ones (Enter / comma), the known tags as toggle chips. Compact form (library cards + detail,
// note footers): a chip row + a "+" that expands into that same input + list in a small popover.
// Spaces are refused (Obsidian tags have none). Classes ytx-tags-*; colors from host tokens.
// createTagEditor({ get, set, suggest?, compact?, chips? }) → { root, refresh, focus, close }
import { normTag, validTag, tagHue } from '../lib/tags.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A coloured #tag chip. opts: { on, count, onClick, x (remove handler) }
export function tagChip(tag, { on = false, count, onClick, x } = {}) {
  const chip = h(onClick ? 'button' : 'span', `ytx-tag${on ? ' is-on' : ''}`, `#${tag}`);
  chip.style.setProperty('--tag-h', tagHue(tag));
  if (onClick) { chip.type = 'button'; chip.setAttribute('aria-pressed', on ? 'true' : 'false'); chip.addEventListener('click', (e) => { e.stopPropagation(); onClick(tag); }); }
  if (count != null) chip.append(' ', h('span', 'ytx-tag-n', String(count)));
  if (x) {
    const b = h('button', 'ytx-tag-x', '✕');
    b.type = 'button';
    b.title = `Remove #${tag}`;
    b.setAttribute('aria-label', `Remove #${tag}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); x(tag); });
    chip.append(b);
  }
  return chip;
}

export function createTagEditor({ get, set, suggest, compact = false, chips: showChips = true }) {
  const root = h('div', compact ? 'ytx-tags ytx-tags-inline' : 'ytx-tags');
  const chips = h('div', 'ytx-tags-chips');
  const input = h('input', 'ytx-tags-input');
  input.type = 'text';
  input.placeholder = 'Find or add tag…';
  input.setAttribute('aria-label', 'Find or add tag');
  input.autocomplete = 'off';
  const known = h('div', 'ytx-tags-known');
  const panel = h('div', compact ? 'ytx-tags-pop' : 'ytx-tags-panel');
  panel.append(input, known);
  let plus = null;
  if (compact) {
    plus = h('button', 'ytx-tags-plus', '+');
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
  function open() {
    input.value = '';
    refresh();
    panel.classList.add('is-open');
    plus?.setAttribute('aria-expanded', 'true');
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    input.focus();
  }
  function close() {
    if (!compact) return;
    panel.classList.remove('is-open');
    plus?.setAttribute('aria-expanded', 'false');
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  }

  const toggle = (t) => set(get().includes(t) ? get().filter((v) => v !== t) : [...get(), t]);
  function refresh() {
    chips.textContent = '';
    for (const t of get()) chips.append(tagChip(t, { x: (tag) => set(get().filter((v) => v !== tag)) }));
    known.textContent = '';
    const q = normTag(input.value);
    const have = new Set(get());
    const all = [...new Set([...(suggest?.() ?? []), ...get()])].sort();
    for (const t of all.filter((t) => !q || t.includes(q))) known.append(tagChip(t, { on: have.has(t), onClick: toggle }));
    if (q && validTag(q) && !all.includes(q)) known.append(newChip(q));
    if (!known.childElementCount) known.append(h('div', 'ytx-tags-empty', q ? 'Keep typing…' : 'No tags yet. Type one.'));
  }
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
    if (e.key === ' ') { e.preventDefault(); flag(); return; } // no spaces in tags
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); return; }
    if (e.key === 'Backspace' && !input.value && get().length) { e.preventDefault(); set(get().slice(0, -1)); return; }
    if (!e.altKey) e.stopPropagation(); // host hotkeys stay out of the field
  });
  input.addEventListener('input', () => { if (/\s/.test(input.value)) { input.value = input.value.replace(/\s+/g, ''); flag(); } refresh(); });
  refresh();
  return { root, refresh, focus: () => input.focus(), close };
}
