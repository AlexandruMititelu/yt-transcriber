// Chat switcher bar + confirm box — shared by the YouTube panel and the library page.
// Classes are unique (ytx-chatbar-*, ytx-confirm-*) so this can load unscoped on youtube.com.
import { chevronDown } from './icons.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// { chats: () => [{id,title}], activeId: () => id, onSelect(id), onNew(), onRename(title), onDelete() }
// → { root, refresh(), open() }  open() = keyboard mode: menu with the current chat focused; arrows move,
//   Enter opens a chat, Alt+Enter deletes the focused chat (host confirms), Esc closes.
export function createChatBar({ chats, activeId, onSelect, onNew, onRename, onDelete }) {
  const root = h('div', 'ytx-chatbar');
  const trigger = h('button', 'ytx-chatbar-trigger');
  trigger.type = 'button';
  trigger.title = 'Chats';
  const label = h('span', 'ytx-chatbar-label');
  const caret = h('span', 'ytx-chatbar-caret');
  caret.appendChild(chevronDown());
  trigger.append(label, caret);
  const menu = h('div', 'ytx-chatbar-menu');
  root.append(trigger, menu);

  const current = () => chats().find((c) => c.id === activeId()) ?? null;

  function row(text, { checked = false, danger = false, disabled = false, icon = '' } = {}, onClick) {
    const b = h('button', `ytx-chatbar-item${danger ? ' ytx-chatbar-danger' : ''}`);
    b.type = 'button';
    b.disabled = disabled;
    b.append(h('span', 'ytx-chatbar-check', checked ? '✓' : ''), h('span', 'ytx-chatbar-text', (icon ? `${icon} ` : '') + text));
    b.addEventListener('click', onClick);
    return b;
  }

  function renderMenu() {
    menu.textContent = '';
    const cur = current();
    const list = chats();
    for (const c of list) {
      const r = row(c.title, { checked: cur?.id === c.id }, () => { closeMenu(); onSelect(c.id); refresh(); });
      r.dataset.chat = c.id;
      menu.append(r);
    }
    if (list.length) menu.append(h('div', 'ytx-chatbar-sep'));
    menu.append(row('New chat', { icon: '+' }, () => { closeMenu(); onNew(); refresh(); }));
    menu.append(h('div', 'ytx-chatbar-sep'));
    menu.append(row('Rename', { disabled: !cur }, () => { closeMenu(); startRename(); }));
    menu.append(row('Delete chat', { danger: true, disabled: !cur }, () => { closeMenu(); onDelete(); }));
  }

  function refresh() {
    const cur = current();
    label.textContent = cur ? cur.title : 'New chat';
    label.classList.toggle('is-placeholder', !cur);
  }

  const onDoc = (e) => { if (!e.composedPath().includes(root)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { closeMenu(); trigger.focus(); return; }
    const rows = [...menu.querySelectorAll('.ytx-chatbar-item:not(:disabled)')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      rows[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    } else if (e.key === 'Enter' && e.altKey && document.activeElement?.dataset.chat) {
      e.preventDefault(); e.stopPropagation();
      const id = document.activeElement.dataset.chat;
      closeMenu();
      if (id !== activeId()) { onSelect(id); refresh(); }
      onDelete();
    }
  };
  function openMenu({ keyboard = false } = {}) {
    renderMenu();
    menu.classList.add('is-open');
    trigger.classList.add('is-open');
    window.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('keydown', onKey, true);
    if (keyboard) (menu.querySelector(`[data-chat="${CSS.escape(activeId() ?? '')}"]`) ?? menu.querySelector('.ytx-chatbar-item'))?.focus();
  }
  function closeMenu() {
    menu.classList.remove('is-open');
    trigger.classList.remove('is-open');
    window.removeEventListener('pointerdown', onDoc, true);
    window.removeEventListener('keydown', onKey, true);
  }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('is-open') ? closeMenu() : openMenu();
  });

  // Rename in place: the trigger becomes a text field until Enter / blur (Esc cancels).
  function startRename() {
    const cur = current();
    if (!cur) return;
    const input = h('input', 'ytx-chatbar-input');
    input.type = 'text';
    input.value = cur.title;
    input.maxLength = 80;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const t = input.value.trim();
      input.replaceWith(trigger);
      if (commit && t && t !== cur.title) onRename(t);
      refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else e.stopPropagation(); // keep YouTube's hotkeys out of the input
    });
    input.addEventListener('blur', () => finish(true));
    trigger.replaceWith(input);
    input.focus();
    input.select();
  }
  trigger.addEventListener('dblclick', (e) => { e.stopPropagation(); closeMenu(); startRename(); });

  refresh();
  return { root, refresh, open: () => (menu.classList.contains('is-open') ? closeMenu() : openMenu({ keyboard: true })) };
}

// Inline confirmation: { text, confirmLabel = 'Delete', onConfirm, onCancel } → element
export function confirmBox({ text, confirmLabel = 'Delete', onConfirm, onCancel }) {
  const box = h('div', 'ytx-confirm');
  box.appendChild(h('div', 'ytx-confirm-text', text));
  const row = h('div', 'ytx-confirm-row');
  const cancel = h('button', 'ytx-confirm-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const ok = h('button', 'ytx-confirm-btn ytx-confirm-danger', confirmLabel);
  ok.type = 'button';
  ok.addEventListener('click', onConfirm);
  row.append(cancel, ok);
  box.appendChild(row);
  return box;
}
