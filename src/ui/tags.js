// Tag editor: chips with ✕ + an input (Enter / comma / space adds, Backspace on empty removes the last).
// Shared by the panel header popover and the library detail. Classes ytx-tags-*; colors from host tokens.
// createTagEditor({ get: () => string[], set: (string[]) => void, suggest?: () => string[] }) → { root, refresh, focus }
import { normTag, validTag } from '../lib/tags.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createTagEditor({ get, set, suggest }) {
  const root = h('div', 'ytx-tags');
  const chips = h('div', 'ytx-tags-chips');
  const input = h('input', 'ytx-tags-input');
  input.type = 'text';
  input.placeholder = 'Add tag…';
  input.setAttribute('aria-label', 'Add tag');
  input.autocomplete = 'off';
  const list = h('datalist');
  list.id = `ytx-tags-${Math.random().toString(36).slice(2, 8)}`;
  input.setAttribute('list', list.id);
  root.append(chips, input, list);

  function refresh() {
    chips.textContent = '';
    for (const t of get()) {
      const chip = h('span', 'ytx-tag ytx-tag-edit', `#${t}`);
      const x = h('button', 'ytx-tag-x', '✕');
      x.type = 'button';
      x.title = `Remove #${t}`;
      x.setAttribute('aria-label', `Remove #${t}`);
      x.addEventListener('click', () => set(get().filter((v) => v !== t)));
      chip.append(x);
      chips.append(chip);
    }
    list.textContent = '';
    const have = new Set(get());
    for (const t of suggest?.() ?? []) if (!have.has(t)) list.append(Object.assign(h('option'), { value: t }));
  }
  function add() {
    const t = normTag(input.value);
    input.value = '';
    if (!validTag(t) || get().includes(t)) return;
    set([...get(), t]);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); return; }
    if (e.key === 'Backspace' && !input.value && get().length) { e.preventDefault(); set(get().slice(0, -1)); return; }
    if (!e.altKey) e.stopPropagation(); // host hotkeys stay out of the field
  });
  input.addEventListener('change', add); // datalist pick
  input.addEventListener('blur', add);
  refresh();
  return { root, refresh, focus: () => input.focus() };
}
