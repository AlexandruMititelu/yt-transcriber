// Keyboard shortcuts — single source of truth for the panel, the library page and the Settings list.
// Not user-remappable (ponytail); Settings only turns them all on or off (settings.hotkeys).
export const HOTKEYS = [
  { id: 'editMode', keys: 'Alt+E', desc: 'Note editor: edit mode (raw markdown)' },
  { id: 'viewMode', keys: 'Alt+V', desc: 'Note editor: view mode (rendered)' },
  { id: 'prevTab', keys: 'Alt+↑', desc: 'Previous tab (Transcript · Chat · Notes)' },
  { id: 'nextTab', keys: 'Alt+↓', desc: 'Next tab' },
];

const BY_KEY = { e: 'editMode', v: 'viewMode', ArrowUp: 'prevTab', ArrowDown: 'nextTab' };

// KeyboardEvent → hotkey id, or null. All shortcuts are Alt + key with no Ctrl/Meta/Shift.
export function hotkeyId(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  return BY_KEY[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}

export const keysFor = (id) => HOTKEYS.find((h) => h.id === id)?.keys ?? '';
