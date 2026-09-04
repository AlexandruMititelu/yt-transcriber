// Firefox ↔ Chromium parity. Fails when the two manifests drift or a Firefox-only surface sneaks in outside
// the known list, so opening the Chromium build later doesn't start from surprises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const ff = JSON.parse(read('manifest.json'));
const cr = JSON.parse(read('manifest.chromium.json'));
const walk = (dir, out = []) => { for (const n of readdirSync(join(root, dir))) { const p = join(dir, n); if (statSync(join(root, p)).isDirectory()) { if (!['vendor', 'node_modules', 'dist', '.git', 'tests'].includes(n)) walk(p, out); } else out.push(p); } return out; };
const src = walk('.').filter((p) => /\.(js|css|html)$/.test(p) && !p.startsWith('scripts/'));

test('manifests: same permissions, hosts, content scripts, resources, action icon', () => {
  assert.deepEqual(new Set(cr.permissions), new Set(ff.permissions.filter((p) => !p.includes('://'))));
  assert.deepEqual(cr.host_permissions, ff.permissions.filter((p) => p.includes('://')));
  assert.deepEqual(cr.web_accessible_resources[0].resources, ff.web_accessible_resources);
  assert.deepEqual(cr.content_scripts[0].js.at(-1), ff.content_scripts[0].js.at(-1));
  assert.ok(cr.content_scripts[0].js[0].endsWith('compat.js'), 'chromium content script loads the browser→chrome alias first');
  assert.deepEqual(cr.content_scripts[0].css, ff.content_scripts[0].css);
  assert.equal(cr.action.default_icon, ff.browser_action.default_icon);
  assert.equal(cr.background.service_worker, ff.background.scripts[0]);
  assert.ok(ff.permissions.includes('unlimitedStorage') && cr.permissions.includes('unlimitedStorage'), 'Chromium caps storage.local at 10 MB without it (frames in chats, transcripts)');
  assert.ok(cr.key, 'fixed extension id: the native host manifest allows chrome-extension://<id>/');
});

test('background + page code only touch `browser.*` (aliased to chrome in Chromium), never `chrome.*` directly', () => {
  for (const p of src) {
    const s = read(p);
    if (p === 'src/lib/compat.js' || p === 'background.js') continue;
    assert.ok(!/\bchrome\.\w+/.test(s), `${p} uses chrome.* directly`);
  }
  assert.match(read('background.js'), /typeof browser === 'undefined'\) globalThis\.browser = chrome/);
  assert.match(read('content/yt.js'), /typeof browser === 'undefined'/);
});

test('Firefox-only surface stays inside the known list', () => {
  // Keys/APIs Chromium ignores or lacks. Add here on purpose; anything new elsewhere fails the test.
  const KNOWN = {
    'manifest.json': ['theme_icons', 'browser_specific_settings', 'browser_action'],
    'content/yt.css': ['-moz-appearance'],
    'background.js': ['browser.browserAction'], // guarded: browser.action || browser.browserAction
  };
  const MARKERS = ['theme_icons', 'browser_specific_settings', 'browser_action', '-moz-', 'moz-extension:', 'browser.browserAction', 'sidebar_action', 'InstallTrigger', 'XPCOM'];
  for (const p of [...src, 'manifest.json']) {
    const s = read(p);
    for (const m of MARKERS) {
      if (!s.includes(m)) continue;
      const allowed = (KNOWN[p] ?? []).some((k) => m.startsWith(k) || k.startsWith(m));
      const comment = m === 'moz-extension:' && /\/\/[^\n]*moz-extension:/.test(s) && !/['"`]moz-extension:/.test(s); // only in comments
      assert.ok(allowed || comment, `${p}: Firefox-only "${m}" outside the known list`);
    }
  }
  // Chromium 121+ has scrollbar-width/scrollbar-color; older builds just show default scrollbars: fine, but keep them
  // paired with a ::-webkit-scrollbar rule where we hide one entirely.
  for (const p of src.filter((x) => x.endsWith('.css'))) {
    const s = read(p);
    if (/scrollbar-width:\s*none/.test(s)) assert.match(s, /::-webkit-scrollbar\s*\{\s*display:\s*none/, `${p} hides a scrollbar for Firefox only`);
  }
});
