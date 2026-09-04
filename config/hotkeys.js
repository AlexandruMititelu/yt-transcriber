// Keyboard shortcuts — single source of truth for the panel, the library page and the Settings list.
// Not user-remappable (ponytail); Settings only turns them all on or off (settings.hotkeys).
export const HOTKEYS = [
  { id: 'editMode', keys: 'Alt+E', desc: 'Note editor: edit mode (raw markdown)' },
  { id: 'viewMode', keys: 'Alt+V', desc: 'Note editor: view mode (rendered)' },
  { id: 'prevTab', keys: 'Alt+↑', desc: 'Previous tab (Transcript · Chat · Notes)' },
  { id: 'nextTab', keys: 'Alt+↓', desc: 'Next tab' },
  { id: 'webSearch', keys: 'Alt+W', desc: 'Toggle web search (Chat tab only)' },
  { id: 'focusChat', keys: 'Alt+C', desc: 'Go to Chat and focus the message box' },
  { id: 'newNote', keys: 'Alt+N', desc: 'Go to Notes and start a new note' },
  { id: 'quickNote', keys: 'Alt+Q', desc: 'Go to Notes and start a quick note' },
  { id: 'toggleNote', keys: 'Alt+Enter', desc: 'Note editor: back to the list (card stays selected) / open the selected note' },
  { id: 'prevNote', keys: "Alt+'", desc: 'Select the previous note (wraps)' },
  { id: 'nextNote', keys: 'Alt+\\', desc: 'Select the next note (wraps)' },
  { id: 'deleteNote', keys: 'Alt+Backspace', desc: 'Focus the trash of the selected / open note; Enter asks, Enter again deletes (Esc keeps it)' },
  { id: 'focusVideo', keys: 'Alt+Shift+Enter', desc: 'Focus the YouTube player (space plays/pauses)' },
  { id: 'findTranscript', keys: 'Alt+F', desc: 'Go to Transcript and focus the search box' },
];

const BY_KEY = {
  e: 'editMode', v: 'viewMode', w: 'webSearch', c: 'focusChat', n: 'newNote', q: 'quickNote',
  f: 'findTranscript', "'": 'prevNote', '\\': 'nextNote', Enter: 'toggleNote', Backspace: 'deleteNote', ArrowUp: 'prevTab', ArrowDown: 'nextTab',
};

// KeyboardEvent → hotkey id, or null. All shortcuts are Alt + key; Shift is only valid for Alt+Shift+Enter.
export function hotkeyId(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey) return e.key === 'Enter' ? 'focusVideo' : null;
  return BY_KEY[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}

export const keysFor = (id) => HOTKEYS.find((h) => h.id === id)?.keys ?? '';
