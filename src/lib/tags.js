// Obsidian tags: letters, digits, _ - and / (nesting), no spaces, case-insensitive, never all digits.
// Videos carry an explicit `tags` list (hub note front matter); notes use inline #tags in their text.
const TAG_CHARS = /[^\p{L}\p{N}_/-]/gu;

export const normTag = (s) => String(s ?? '').trim().replace(/^#+/, '').toLowerCase()
  .replace(TAG_CHARS, '').replace(/^\/+|\/+$/g, ''); // spaces are dropped, never dashed: the editor refuses them
// Colour per tag: assigned once, kept forever (settings.tagColors). New tags walk the golden angle so
// neighbours stay far apart. Until configured (tests, first paint) a name hash stands in.
const hashHue = (t) => { let x = 0; for (const c of String(t)) x = (x * 31 + c.codePointAt(0)) >>> 0; return x % 360; };
let colors = null; // { tag: hue }
let persist = null;
export function configureTagColors(map, save) { colors = { ...(map ?? {}) }; persist = save; }
export function tagHue(t) {
  if (!colors) return hashHue(t);
  if (!(t in colors)) {
    colors[t] = Math.round((Object.keys(colors).length * 137.508) % 360);
    persist?.({ ...colors });
  }
  return colors[t];
}
export const validTag = (t) => !!t && !/^\d+$/.test(t);
const uniq = (arr) => [...new Set(arr.filter(validTag))];

// Inline #tags: at line start or after whitespace/( (so "# heading" and url#anchor don't count).
export function extractTags(text) {
  return uniq([...String(text ?? '').matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)].map((m) => normTag(m[1])));
}

// Front-matter `tags` in any Obsidian spelling: array, "[a, b]", "a, b", "#a #b", or the raw block
// "tags:\n  - a\n  - b" → normalised list.
export function parseTagList(v) {
  if (Array.isArray(v)) return uniq(v.map(normTag));
  const s = String(v ?? '').replace(/^tags:/, '');
  return uniq(s.split(/[\s,[\]]+/).filter((w) => w && w !== '-').map(normTag));
}

// Wrap inline #tags in rendered markdown with <span class="ytx-tag"> (skips code, links).
export function chipTags(root, onClick) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('code, pre, a, .ytx-tag')) continue;
    if (/(?:^|[\s(])#[\p{L}\p{N}_/-]+/u.test(n.data)) nodes.push(n);
  }
  for (const n of nodes) {
    const frag = root.ownerDocument.createDocumentFragment();
    let i = 0;
    for (const m of n.data.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
      const tag = normTag(m[2]);
      if (!validTag(tag)) continue;
      const at = m.index + m[1].length;
      frag.append(n.data.slice(i, at));
      const chip = root.ownerDocument.createElement('span');
      chip.className = 'ytx-tag';
      chip.style.setProperty('--tag-h', tagHue(tag));
      chip.textContent = m[2]; // chips show the bare name; the text keeps its #
      chip.dataset.tag = tag;
      if (onClick) { chip.setAttribute('role', 'button'); chip.tabIndex = 0; chip.addEventListener('click', (e) => { e.stopPropagation(); onClick(tag); }); }
      frag.append(chip);
      i = at + 1 + m[2].length;
    }
    frag.append(n.data.slice(i));
    n.replaceWith(frag);
  }
}
