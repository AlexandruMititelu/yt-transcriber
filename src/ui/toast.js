// One toaster per host: `createToaster(hostEl)` → toast(msg, { link?, error?, ms? }).
// Errors stay longer and get a close button; the region is announced to screen readers.
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function createToaster(host, { fixed = false } = {}) {
  let cur = null;
  let timer = null;
  return function toast(msg, { link, error, ms, action } = {}) {
    if (cur) { cur.remove(); cur = null; clearTimeout(timer); }
    const text = msg instanceof Node ? msg.textContent : String(msg);
    const isErr = error ?? /fail|error|not reachable|unable|denied|timeout/i.test(text);
    const t = h('div', `ytx-toast${isErr ? ' is-error' : ''}${fixed ? ' is-fixed' : ''}`);
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.append(msg instanceof Node ? msg : h('span', 'ytx-toast-text', text));
    if (link) {
      const a = h('a', 'ytx-toast-link', link.label || 'Open');
      a.href = link.href;
      if (link.blank !== false) { a.target = '_blank'; a.rel = 'noreferrer'; }
      t.append(a);
    }
    const hide = () => { t.classList.add('is-out'); setTimeout(() => t.remove(), 220); if (cur === t) cur = null; };
    if (action) {
      const b = h('button', 'ytx-toast-link', action.label);
      b.type = 'button';
      b.addEventListener('click', () => { hide(); action.onClick(); });
      t.append(b);
    }
    if (isErr) {
      const x = h('button', 'ytx-toast-x', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', hide);
      t.append(x);
    }
    host.appendChild(t);
    cur = t;
    timer = setTimeout(hide, ms ?? (isErr ? 7000 : action ? 5000 : 2200));
  };
}
