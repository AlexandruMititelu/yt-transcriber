// Model + effort picker (Claude.ai style): text trigger, popover menu, effort submenu.
// Custom because native <select> renders optgroup labels in the OS font.
import * as db from '../lib/db.js';
import * as llm from '../lib/llm.js';
import { chevronDown } from './icons.js';

const PROVIDER_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI' };
const EFFORT_LABEL = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High' };

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createPicker({ isLive = () => true, onChange } = {}) {
  const root = h('div', 'ytx-picker');
  const trigger = h('button', 'ytx-picker-trigger');
  trigger.type = 'button';
  trigger.title = 'Model and effort';
  const menu = h('div', 'ytx-picker-menu');
  const list = h('div', 'ytx-picker-list');
  const footer = h('div', 'ytx-picker-footer');
  menu.append(list, footer);
  root.append(trigger, menu);

  let settings = { model: '', effort: 'off', webSearch: false };
  let groups = {};
  let view = 'models';

  const canThink = () => {
    const { provider, id } = llm.parseModel(settings.model);
    return llm.supportsEffort(provider, id);
  };
  function label() {
    trigger.replaceChildren(h('span', 'ytx-picker-model', llm.parseModel(settings.model).id));
    const eff = h('span', 'ytx-picker-effort', canThink() ? (EFFORT_LABEL[settings.effort] ?? 'Off') : 'No effort');
    if (!canThink()) { eff.classList.add('is-off'); eff.title = 'This model has no thinking/effort setting'; }
    trigger.append(eff);
    const caret = h('span', 'ytx-picker-caret');
    caret.appendChild(chevronDown());
    trigger.append(caret);
  }
  function set(patch) {
    Object.assign(settings, patch);
    db.saveSettings(patch).then(() => onChange?.(settings)).catch(() => {});
    label();
  }
  function item(text, right, onClick) {
    const b = h('button', 'ytx-picker-item');
    b.type = 'button';
    b.append(h('span', 'ytx-picker-item-text', text));
    if (right) b.append(right);
    b.addEventListener('click', onClick);
    return b;
  }
  const check = () => h('span', 'ytx-picker-check', '✓');

  function render() {
    list.textContent = '';
    footer.textContent = '';
    const ok = canThink();
    if (view === 'effort') {
      for (const e of llm.EFFORTS) {
        list.append(item(EFFORT_LABEL[e], e === settings.effort ? check() : null, () => { set({ effort: e }); close(); }));
      }
    } else {
      const entries = Object.entries(groups);
      if (!entries.length) list.append(h('div', 'ytx-picker-empty', 'No API key. Add one in Library › Settings.'));
      for (const [provider, ids] of entries) {
        list.append(h('div', 'ytx-picker-group', PROVIDER_LABEL[provider] ?? provider));
        for (const id of ids) {
          const v = `${provider}:${id}`;
          list.append(item(id, v === settings.model ? check() : null, () => { set({ model: v }); close(); }));
        }
      }
    }
    // Effort row lives in a sticky footer so it never needs scrolling to; it toggles the submenu.
    const val = h('span', 'ytx-picker-value',
      !ok ? 'Not supported' : view === 'effort' ? '‹ Back' : `${EFFORT_LABEL[settings.effort] ?? 'Off'} ›`);
    const eff = item('Effort', val, () => { view = view === 'effort' ? 'models' : 'effort'; render(); });
    eff.disabled = !ok;
    footer.append(eff);
  }

  // composedPath, not root.contains: a click that re-renders the menu detaches its target
  // Capture-phase pointerdown on window: fires before YouTube's own handlers, which stop propagation.
  const onDoc = (e) => { if (!e.composedPath().includes(root)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function open() {
    view = 'models';
    render();
    menu.classList.add('is-open');
    trigger.classList.add('is-open');
    window.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('keydown', onKey, true);
  }
  function close() {
    menu.classList.remove('is-open');
    trigger.classList.remove('is-open');
    window.removeEventListener('pointerdown', onDoc, true);
    window.removeEventListener('keydown', onKey, true);
  }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });

  (async () => {
    settings = await db.getSettings();
    label();
    onChange?.(settings);
    groups = await llm.modelGroups(settings);
    if (!isLive()) return;
    const model = llm.resolveModel(settings, groups);
    if (model !== settings.model) set({ model });
  })().catch((e) => console.warn('[ytx] picker', e));

  return root;
}
