// Ctrl + right-click on selected text (chat message, transcript row) → small menu: Copy · Copy as quote ·
// Quote in a new note. The quote is a markdown blockquote ending in a link back to where it came from.
// attachQuoteMenu(root, { source(node) → { label } | null, onNote?(quote, src), toast })
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const buildQuote = (text, label) => `> ${String(text).trim().split('\n').join('\n> ')}\n> — ${label}`;

export function attachQuoteMenu(root, { source, onNote, toast }) {
  let menu = null;
  const onDown = (e) => { if (menu && !menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  }
  const copy = (s) => navigator.clipboard.writeText(s).then(() => toast?.('Copied'), () => toast?.('Copy failed'));
  root.addEventListener('contextmenu', (e) => {
    if (!e.ctrlKey) return; // plain right-click keeps the browser menu
    const sel = root.ownerDocument.getSelection();
    const text = sel?.toString().trim();
    if (!text || !sel.rangeCount || !root.contains(sel.anchorNode)) return;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const src = source(node.nodeType === 1 ? node : node.parentElement);
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    close();
    const quote = buildQuote(text, src.label);
    menu = h('div', 'ytx-qmenu');
    menu.setAttribute('role', 'menu');
    const item = (label, fn) => {
      const b = h('button', 'ytx-qmenu-item', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => { close(); fn(); });
      menu.append(b);
    };
    item('Copy', () => copy(text));
    item('Copy as quote', () => copy(quote));
    if (onNote) item('Quote in a new note', () => onNote(quote, src));
    // Positioned inside the nearest positioned host (the panel, or the page body) at the pointer.
    const host = root.closest('#ytx-panel') ?? root.ownerDocument.body;
    const r = host.getBoundingClientRect();
    menu.style.left = `${e.clientX - r.left + host.scrollLeft}px`;
    menu.style.top = `${e.clientY - r.top + host.scrollTop}px`;
    host.append(menu);
    const mr = menu.getBoundingClientRect(); // keep it inside the host
    if (mr.right > r.right) menu.style.left = `${e.clientX - r.left - mr.width}px`;
    if (mr.bottom > r.bottom) menu.style.top = `${e.clientY - r.top - mr.height}px`;
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    menu.firstElementChild.focus();
  });
  return { close };
}
