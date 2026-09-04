// Tag editor: selected tags as chips with ✕, an input that both filters the known tags and creates new
// ones (Enter / comma), and the known tags as toggle chips. Spaces are refused (Obsidian tags have none).
// Shared by the panel header popover and the library detail. Classes ytx-tags-*; colors from host tokens.
// createTagEditor({ get: () => string[], set: (string[]) => void, suggest?: () => string[] }) → { root, refresh, focus }
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

export function createTagEditor({ get, set, suggest }) {
  const root = h('div', 'ytx-tags');
  const chips = h('div', 'ytx-tags-chips');
  const input = h('input', 'ytx-tags-input');
  input.type = 'text';
  input.placeholder = 'Find or add tag…';
  input.setAttribute('aria-label', 'Find or add tag');
  input.autocomplete = 'off';
  const known = h('div', 'ytx-tags-known');
  root.append(chips, input, known);

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
  return { root, refresh, focus: () => input.focus() };
}
