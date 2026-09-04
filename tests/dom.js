// Tiny DOM stand-in for smoke tests: enough for the UI modules to build their trees without a browser.
// No layout, no real selector engine (last compound of a selector: tag, .class, #id, [attr=val]); events are
// stored and can be fired with el.dispatchEvent / el.click(). Anything missing throws, which is the point.
class ClassList {
  constructor(el) { this.el = el; }
  get list() { return this.el.className.split(/\s+/).filter(Boolean); }
  set(list) { this.el.className = list.join(' '); }
  add(...c) { this.set([...new Set([...this.list, ...c])]); }
  remove(...c) { this.set(this.list.filter((x) => !c.includes(x))); }
  toggle(c, force) { const on = force ?? !this.list.includes(c); if (on) this.add(c); else this.remove(c); return on; }
  contains(c) { return this.list.includes(c); }
}
function matchesCompound(el, compound) {
  if (!(el instanceof Element)) return false;
  const parts = compound.match(/\[[^\]]*\]|:not\([^)]*\)|:[\w-]+(\([^)]*\))?|[.#]?[\w-]+/g) ?? [];
  return parts.every((p) => {
    if (p.startsWith('.')) return el.classList.contains(p.slice(1));
    if (p.startsWith('#')) return el.id === p.slice(1);
    if (p.startsWith('[')) {
      const m = /^\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]$/.exec(p);
      if (!m) return true;
      const v = el.getAttribute(m[1]);
      if (m[2] == null) return v != null;
      return m[2] === '^=' ? String(v ?? '').startsWith(m[3]) : v === m[3];
    }
    if (p.startsWith(':')) return !p.startsWith(':disabled') || el.disabled === true;
    return el.tagName === p.toUpperCase();
  });
}
function matches(el, selector) {
  return selector.split(',').some((s) => {
    const compounds = s.trim().replace(/:scope\s*>?\s*/, '').split(/\s*>\s*|\s+/).filter(Boolean);
    return compounds.length ? matchesCompound(el, compounds.at(-1)) : false;
  });
}
let doc = null; // the one Document, set in its constructor (globals come later)
class Node {
  constructor() { this.parentNode = null; this.parentElement = null; this.ownerDocument = null; }
  get isConnected() { let n = this; while (n) { if (n === doc?.body || n === doc?.documentElement || n === doc) return true; n = n.parentNode; } return false; }
}
class Text extends Node {
  constructor(data) { super(); this.data = String(data); this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  replaceWith(...nodes) { this.parentNode?._replace(this, nodes); }
  remove() { this.parentNode?._remove(this); }
  get nextSibling() { return this.parentNode?._sibling(this, 1) ?? null; }
}
class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.attrs = {};
    this.className = '';
    this.classList = new ClassList(this);
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.offsetWidth = 0; this.offsetHeight = 0; this.offsetTop = 0; this.offsetParent = this;
  }
  get id() { return this.attrs.id ?? ''; }
  get src() { return this.attrs.src ?? ''; }
  set src(v) { this.attrs.src = String(v); }
  get href() { return this.attrs.href ?? ''; }
  set href(v) { this.attrs.href = String(v); }
  set id(v) { this.attrs.id = v; }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.childNodes[0] ?? null; }
  _adopt(n) { if (typeof n === 'string' || typeof n === 'number') n = new Text(n); if (n instanceof Fragment) return n.childNodes.splice(0).map((c) => this._adopt(c)); n.parentNode?._remove(n); n.parentNode = this; n.parentElement = this; n.ownerDocument = doc; return [n]; }
  append(...nodes) { for (const n of nodes) { if (n == null) continue; this.childNodes.push(...this._adopt(n)); } }
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) { const adopted = nodes.flatMap((n) => (n == null ? [] : this._adopt(n))); this.childNodes.unshift(...adopted); }
  insertBefore(n, ref) { const i = this.childNodes.indexOf(ref); const a = this._adopt(n); if (i < 0) this.childNodes.push(...a); else this.childNodes.splice(i, 0, ...a); return n; }
  replaceChildren(...nodes) { for (const c of this.childNodes) { c.parentNode = null; c.parentElement = null; } this.childNodes = []; this.append(...nodes); }
  _remove(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; n.parentElement = null; }
  _replace(old, nodes) { const i = this.childNodes.indexOf(old); if (i < 0) return; old.parentNode = null; const a = nodes.flatMap((n) => this._adopt(n)); this.childNodes.splice(i, 1, ...a); }
  _sibling(n, d) { const i = this.childNodes.indexOf(n); return this.childNodes[i + d] ?? null; }
  remove() { this.parentNode?._remove(this); }
  replaceWith(...nodes) { this.parentNode?._replace(this, nodes); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v != null) this.childNodes.push(...this._adopt(String(v))); }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.replaceChildren(); parseHtml(String(v), this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : (this.attrs[k] ?? null); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatchEvent(ev) { ev.target ??= this; let n = this; while (n) { for (const f of n.listeners?.[ev.type] ?? []) f.call(n, ev); if (ev._stopped) break; n = n.parentNode; } return true; }
  click() { this.dispatchEvent(new Event('click')); if (typeof this.onclick === 'function') this.onclick(new Event('click')); }
  focus() { doc.activeElement = this; for (const f of this.listeners.focus ?? []) f.call(this, new Event('focus', { bubbles: false })); }
  blur() { if (doc.activeElement !== this) return; doc.activeElement = doc.body; for (const f of this.listeners.blur ?? []) f.call(this, new Event('blur', { bubbles: false })); }
  select() {}
  scrollIntoView() {}
  scrollTo() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  *_walk() { for (const c of this.childNodes) { yield c; if (c instanceof Element) yield* c._walk(); } }
  querySelectorAll(sel) { return [...this._walk()].filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) { let n = this; while (n) { if (n instanceof Element && matches(n, sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return matches(this, sel); }
  cloneNode() { const c = new Element(this.tagName); c.className = this.className; c.attrs = { ...this.attrs }; for (const k of this.childNodes) c.append(k instanceof Text ? k.data : k.cloneNode(true)); return c; }
}
class Fragment extends Element { constructor() { super('#fragment'); } }
// Naive HTML → nodes: <tag attr="v" attr2=v>…</tag>, self-closing/void tags, entities &amp; &lt; &gt; &quot;.
const VOID = new Set(['br', 'hr', 'img', 'input']);
const unesc = (t) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parseHtml(html, root) {
  const re = /<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const stack = [root];
  for (const m of html.matchAll(re)) {
    const cur = stack.at(-1);
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const el = new Element(m[2]);
      el.ownerDocument = doc;
      for (const a of m[3].matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const val = a[2] ?? a[3] ?? a[4] ?? '';
        el.setAttribute(a[1], unesc(val));
        if (a[1].startsWith('data-')) el.dataset[a[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unesc(val);
      }
      cur.append(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
      continue;
    }
    if (m[5]) cur.append(unesc(m[5]));
  }
}
class Event { constructor(type, init = {}) { Object.assign(this, { type, bubbles: true, ...init }); } preventDefault() { this.defaultPrevented = true; } stopPropagation() { this._stopped = true; } composedPath() { const p = []; let n = this.target; while (n) { p.push(n); n = n.parentNode; } return p; } }
class KeyboardEvent extends Event {}
class Document extends Element {
  constructor() {
    super('#document');
    doc = this;
    this.documentElement = new Element('html');
    this.head = new Element('head');
    this.body = new Element('body');
    super.append(this.documentElement);
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { const e = new Element(tag); e.ownerDocument = this; return e; }
  createElementNS(ns, tag) { return this.createElement(tag); }
  createTextNode(t) { return new Text(t); }
  createDocumentFragment() { return new Fragment(); }
  createTreeWalker(root) { const nodes = [...root._walk()].filter((n) => n instanceof Text); let i = -1; return { nextNode: () => nodes[++i] ?? null }; }
  getElementById(id) { return this.querySelector(`#${id}`); }
  getSelection() { return { toString: () => '', rangeCount: 0, removeAllRanges() {} }; }
}
export function installDom() {
  const document = new Document();
  const listeners = {};
  const win = {
    document,
    addEventListener(t, fn) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    dispatchEvent(ev) { for (const f of listeners[ev.type] ?? []) f(ev); return true; },
    innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
    location: { hash: '', href: 'https://example.test/page/app.html' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getSelection: () => document.getSelection(),
  };
  Object.assign(globalThis, {
    document, window: win, Element, Node, Text, Event, KeyboardEvent, HTMLElement: Element, NodeFilter: { SHOW_TEXT: 4 },
    location: win.location, matchMedia: win.matchMedia, requestAnimationFrame: win.requestAnimationFrame, getSelection: win.getSelection,
    innerWidth: 1200, innerHeight: 800,
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) },
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener: win.addEventListener, removeEventListener: win.removeEventListener, dispatchEvent: win.dispatchEvent,
    marked: { parse: (t) => `<p>${t}</p>` },
    DOMPurify: { sanitize: (s, o) => (o?.FORBID_TAGS ?? []).reduce((acc, tag) => acc.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), ''), s) },
    fetch: async () => ({ text: async () => '', ok: true, json: async () => ({}) }),
  });
  return { document, window: win };
}
