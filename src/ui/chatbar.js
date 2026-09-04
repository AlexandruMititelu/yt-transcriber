// Chat switcher bar + confirm box — shared by the YouTube panel and the library page.
// Classes are unique (ytx-chatbar-*, ytx-confirm-*) so this can load unscoped on youtube.com.
const NEW = '__new';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// { chats: () => [{id,title}], activeId: () => id, onSelect(id), onNew(), onRename(title), onDelete() }
// → { root, refresh() }
export function createChatBar({ chats, activeId, onSelect, onNew, onRename, onDelete }) {
  const root = h('div', 'ytx-chatbar');
  const select = h('select', 'ytx-chatbar-select');
  select.title = 'Switch chat';
  const menuBtn = h('button', 'ytx-chatbar-btn', '⋯');
  menuBtn.type = 'button';
  menuBtn.title = 'Chat actions';
  const menu = h('div', 'ytx-chatbar-menu');
  const renameBtn = h('button', 'ytx-chatbar-item', 'Rename');
  renameBtn.type = 'button';
  const deleteBtn = h('button', 'ytx-chatbar-item ytx-chatbar-danger', 'Delete chat');
  deleteBtn.type = 'button';
  menu.append(renameBtn, deleteBtn);
  root.append(select, menuBtn, menu);

  function refresh() {
    select.textContent = '';
    const list = chats();
    for (const c of list) {
      const o = h('option', null, c.title);
      o.value = c.id;
      select.appendChild(o);
    }
    const n = h('option', null, '＋ New chat');
    n.value = NEW;
    select.appendChild(n);
    select.value = list.some((c) => c.id === activeId()) ? activeId() : NEW;
    const has = list.length > 0 && select.value !== NEW;
    renameBtn.disabled = deleteBtn.disabled = !has;
  }

  select.addEventListener('change', () => {
    if (select.value === NEW) onNew();
    else onSelect(select.value);
    refresh();
  });

  const onDoc = (e) => { if (!e.composedPath().includes(root)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  function openMenu() {
    menu.classList.add('is-open');
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
  }
  function closeMenu() {
    menu.classList.remove('is-open');
    document.removeEventListener('click', onDoc);
    document.removeEventListener('keydown', onKey);
  }
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('is-open') ? closeMenu() : openMenu();
  });

  renameBtn.addEventListener('click', () => {
    closeMenu();
    const cur = chats().find((c) => c.id === activeId());
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
      input.replaceWith(select);
      if (commit && t && t !== cur.title) onRename(t);
      refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else e.stopPropagation(); // keep YouTube's hotkeys out of the input
    });
    input.addEventListener('blur', () => finish(true));
    select.replaceWith(input);
    input.focus();
    input.select();
  });

  deleteBtn.addEventListener('click', () => { closeMenu(); onDelete(); });

  refresh();
  return { root, refresh };
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
