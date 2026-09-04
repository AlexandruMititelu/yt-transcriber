// Markdown → DOM, shared by the panel and the library page: sanitized marked output, links open in a
// new tab, [12:34] / @12:34 become time chips, code blocks get a copy button, mermaid fences render.
// Vendors (marked, DOMPurify) are UMD globals loaded by the host; mermaid loads lazily from vendor/.

import { expandIcon } from './icons.js';

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// [12:34] (assistant citations) and @12:34 (typed in notes) — h:mm:ss or m:ss.
export const TS_RE = /(?:\[(\d{1,3}(?::[0-5]?\d){1,2})\]|@(\d{1,3}(?::[0-5]?\d){1,2}))/g;
export const stampToSec = (stamp) => stamp.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);

// Chips: <button> that seeks when `onSeek` is given (watch page), else <a> to `timeHref(sec)` (library).
export function linkifyTimestamps(root, { onSeek, timeHref } = {}) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && n.parentElement.closest('pre, code, a, button')) continue;
    TS_RE.lastIndex = 0;
    if (TS_RE.test(n.nodeValue)) nodes.push(n);
  }
  TS_RE.lastIndex = 0; // matchAll clones the regex INCLUDING lastIndex; reset the stale offset from .test()
  for (const node of nodes) {
    const s = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of s.matchAll(TS_RE)) {
      frag.append(s.slice(last, m.index));
      const stamp = m[1] || m[2];
      const sec = stampToSec(stamp);
      let chip;
      if (onSeek) {
        chip = h('button', 'ytx-ts', stamp);
        chip.type = 'button';
        chip.addEventListener('click', () => onSeek(sec));
      } else {
        chip = h('a', 'ytx-ts', stamp);
        chip.href = timeHref ? timeHref(sec) : '#';
        chip.target = '_blank';
        chip.rel = 'noreferrer';
      }
      frag.append(chip);
      last = m.index + m[0].length;
    }
    frag.append(s.slice(last));
    node.replaceWith(frag);
  }
}

/* ---- mermaid (lazy, one instance per page) ---- */
let mermaidP = null;
let mermaidSeq = 0;
let dark = false;
const mermaidCfg = () => ({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });

// Host calls this when its theme flips; already-rendered SVGs keep theirs.
export function setDark(on) {
  dark = !!on;
  if (mermaidP) mermaidP.then((m) => m.initialize(mermaidCfg())).catch(() => {});
}

function ensureMermaid() {
  if (!mermaidP) {
    mermaidP = import(new URL('../../vendor/mermaid.min.js', import.meta.url).href).then(() => {
      globalThis.mermaid.initialize(mermaidCfg());
      return globalThis.mermaid;
    }).catch((e) => { mermaidP = null; throw e; }); // don't cache a transient load failure
  }
  return mermaidP;
}

export async function renderMermaidIn(root) {
  const blocks = root.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;
  try {
    const mermaid = await ensureMermaid();
    for (const code of blocks) {
      try {
        let res = mermaid.render(`ytx-mmd-${++mermaidSeq}`, code.textContent);
        if (res && typeof res.then === 'function') res = await res;
        const svg = typeof res === 'string' ? res : res.svg;
        const wrap = h('div', 'ytx-mermaid');
        wrap.innerHTML = svg; // mermaid output, securityLevel 'strict'
        wrap.append(expandBtn(wrap));
        code.parentElement.replaceWith(wrap);
      } catch { /* invalid diagram: leave the fenced block visible */ }
    }
  } catch { /* mermaid failed to load: fenced blocks stay as code */ }
}

// Top-right expander: the diagram in a full-screen overlay (dark backdrop), Escape / click outside closes.
function expandBtn(wrap) {
  const b = h('button', 'ytx-mmd-expand');
  b.type = 'button';
  b.title = 'Expand diagram';
  b.setAttribute('aria-label', 'Expand diagram');
  b.appendChild(expandIcon());
  b.addEventListener('click', () => {
    // On document.body: YouTube's layout ancestors make `position: fixed` inside the panel a panel-sized box.
    const host = document.body;
    const dark = wrap.closest('#ytx-panel')?.classList.contains('ytx-dark') || document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const overlay = h('div', 'ytx-mmd-overlay');
    const box = h('div', 'ytx-mmd-box');
    box.style.background = dark ? '#1e1e20' : '#fdf6e3';
    const svg = wrap.querySelector('svg')?.cloneNode(true);
    if (!svg) return;
    svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.maxWidth = '100%'; svg.style.maxHeight = '100%';
    box.append(svg);
    const close = h('button', 'ytx-mmd-close', '✕');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    overlay.append(box, close);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    const done = () => { overlay.remove(); window.removeEventListener('keydown', onKey, true); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === close) done(); });
    window.addEventListener('keydown', onKey, true);
    host.append(overlay);
    close.focus();
  });
  return b;
}

// Copy button + language tag on every <pre>.
function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code || code.classList.contains('language-mermaid')) continue;
    const lang = (/language-([\w-]+)/.exec(code.className) || [])[1];
    const bar = h('div', 'ytx-code-bar');
    if (lang) bar.append(h('span', 'ytx-code-lang', lang));
    const btn = h('button', 'ytx-code-copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      }).catch(() => { btn.textContent = 'Failed'; });
    });
    bar.append(btn);
    pre.classList.add('ytx-pre');
    pre.prepend(bar);
  }
}

// { onSeek?(sec), timeHref?(sec) → url, cls? } → element
// Obsidian [[target|label]] links → <a class=ytx-wiki data-target>; the host's onWiki(target) opens them (a chat file, say).
const WIKI = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const EMBED = /!\[\[([^\]|]+?\.(?:jpe?g|png|webp|gif))(?:\|[^\]]*)?\]\]/gi;
// Image embeds (frame captures) become placeholders; the host resolves them to data: URLs via onEmbed (no remote
// images ever: <img> stays forbidden in the sanitizer, these are built by DOM after the fact).
const wikiToHtml = (text) => String(text ?? '')
  .replace(EMBED, (_, f) => `<span class="ytx-embed" data-file="${esc(f.trim())}">${esc(f.trim())}</span>`)
  .replace(WIKI, (_, t, l) => `<a class="ytx-wiki" href="#" data-target="${esc(t.trim())}">${esc((l ?? t).trim())}</a>`);

export function renderMarkdown(text, { onSeek, timeHref, onWiki, onEmbed, cls = 'ytx-md' } = {}) {
  const md = h('div', cls);
  // FORBID_TAGS img: a prompt-injected transcript could make the LLM emit an image URL that exfiltrates chat content on fetch
  md.innerHTML = globalThis.DOMPurify.sanitize(globalThis.marked.parse(wikiToHtml(text)), { FORBID_TAGS: ['img'] });
  for (const a of md.querySelectorAll('a.ytx-wiki')) {
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onWiki?.(a.dataset.target); });
  }
  for (const a of md.querySelectorAll('a[href]:not(.ytx-wiki)')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
  for (const ph of md.querySelectorAll('span.ytx-embed')) {
    if (!onEmbed) continue;
    Promise.resolve(onEmbed(ph.dataset.file)).then((url) => {
      if (!url || !ph.isConnected) return;
      const img = h('img', 'ytx-embed-img');
      img.src = url;
      img.alt = ph.dataset.file;
      img.loading = 'lazy';
      ph.replaceWith(img);
    }).catch(() => {});
  }
  linkifyTimestamps(md, { onSeek, timeHref });
  decorateCode(md);
  renderMermaidIn(md);
  return md;
}
