// YT Transcriber — watch-page panel. Classic content script: all lib/vendor
// access via dynamic import(browser.runtime.getURL(...)) inside the IIFE.
'use strict';

(async () => {
  if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.getURL) return;

  let gen = 0; // generation counter: teardown bumps it, stale async work aborts
  let L = null; // lib modules, loaded once
  let panel = null;
  let themeObserver = null;
  let resizeObserver = null;
  let flushSave = null; // pending debounced note-save; flushed on teardown so edits survive SPA nav

  const url = (p) => browser.runtime.getURL(p);
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const isDark = () => document.documentElement.hasAttribute('dark');
  const seek = (sec) => {
    const v = document.querySelector('video');
    if (v) { v.currentTime = sec; v.play(); }
  };

  async function loadLibs() {
    if (L) return L;
    const names = ['format', 'transcript', 'bus', 'db', 'llm', 'vault', 'picker', 'chatbar', 'notes', 'icons', 'hotkeys', 'markdown', 'toast', 'chat'];
    const UI = new Set(['picker', 'chatbar', 'notes', 'icons', 'markdown', 'toast', 'chat']);
    const pathFor = (n) => (n === 'hotkeys' ? 'config/hotkeys.js' : UI.has(n) ? `src/ui/${n}.js` : `src/lib/${n}.js`);
    const mods = await Promise.all(names.map((n) => import(url(pathFor(n)))));
    // UMD vendors set globalThis.marked / globalThis.DOMPurify; mermaid loads lazily.
    await Promise.all([import(url('vendor/marked.min.js')), import(url('vendor/purify.min.js'))]);
    L = Object.fromEntries(names.map((n, i) => [n, mods[i]]));
    return L;
  }

  function injectFonts() {
    if (document.getElementById('ytx-fonts')) return;
    const style = h('style');
    style.id = 'ytx-fonts';
    // <link> to a moz-extension: stylesheet gets blocked on youtube.com; inline the text instead.
    for (const name of ['picker', 'chatbar', 'notes', 'markdown', 'toast', 'chat']) {
      fetch(url(`src/ui/${name}.css`)).then((r) => r.text()).then((css) => {
        const s = h('style');
        s.id = `ytx-${name}-css`;
        s.textContent = css;
        document.head.appendChild(s);
      }).catch((e) => console.warn(`[ytx] ${name} css`, e));
    }
    style.textContent = [
      `@font-face{font-family:"Geist";font-style:normal;font-weight:100 900;` +
      `font-display:swap;src:url("${url('vendor/geist-sans.woff2')}") format("woff2");}`,
      ...[400, 600].map((w) =>
        `@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:${w};` +
        `font-display:swap;src:url("${url(`vendor/jetbrains-mono-${w}.woff2`)}") format("woff2");}`
      ),
    ].join('\n');
    document.head.appendChild(style);
  }

  const renderMd = (text) => L.markdown.renderMarkdown(text, { onSeek: seek });

  function scrapeMeta() {
    const title = L.vault.cleanTitle(
      document.querySelector('ytd-watch-metadata h1 yt-formatted-string, h1 yt-formatted-string')?.textContent ||
      document.title,
    );
    const channel = document.querySelector('#owner #channel-name a')?.textContent?.trim() || '';
    return { title, channel };
  }

  // On SPA navigation the h1 / document.title lag behind the URL; poll briefly for the real title.
  async function waitForMeta(myGen, timeout = 6000) {
    const deadline = Date.now() + timeout;
    let meta = scrapeMeta();
    while (!meta.title && Date.now() < deadline && myGen === gen) {
      await new Promise((r) => setTimeout(r, 200));
      meta = scrapeMeta();
    }
    return meta;
  }

  async function waitFor(sel, myGen, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && myGen === gen) {
      const el = document.querySelector(sel);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  function teardown() {
    if (flushSave) { flushSave(); flushSave = null; }
    gen++;
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    const old = document.getElementById('ytx-panel');
    if (old) old.remove();
    panel = null;
  }

  async function init() {
    teardown();
    if (location.pathname !== '/watch') return;
    const videoId = new URLSearchParams(location.search).get('v');
    if (!videoId) return;
    const myGen = gen;
    const live = () => myGen === gen;

    try { await loadLibs(); } catch (e) { console.warn('[ytx] lib load failed', e); return; }
    if (!live()) return;
    injectFonts();

    const secondary = await waitFor('#secondary', myGen);
    if (!secondary || !live()) return;

    const { fmtTime } = L.format;
    const meta = await waitForMeta(myGen);
    const video = (await L.db.getVideo(videoId)) ?? L.db.blankVideo(videoId, meta.title, meta.channel);
    if (!live()) return;
    if (!L.vault.hasTitle(video) && meta.title) video.title = meta.title;
    if (!video.channel && meta.channel) video.channel = meta.channel;

    const save = () => L.db.saveVideo(video).catch((e) => console.warn('[ytx] save failed', e));
    // Debounced note autosave: model updates synchronously in the handlers; the write is
    // debounced, gen-guarded, and flushed on teardown so edits survive SPA nav. Dirty cards /
    // overview are mirrored to disk in the same flush.
    let notesDirty = false;
    const diskDirty = new Set(); // cards
    const flushNotes = () => {
      if (notesDirty) { notesDirty = false; save(); }
      for (const d of diskDirty) disk((s) => L.vault.syncNote(s, video, d).then(onSynced));
      diskDirty.clear();
    };
    // Disk wins on conflict: vault reloaded the item from the file edited in Obsidian.
    const onSynced = (r) => {
      if (r !== 'reloaded' || !live()) return;
      save();
      renderNotes();
      renderChat();
      toast('Changed in Obsidian: reloaded from disk');
    };
    const saveSoon = debounce(() => { if (live()) flushNotes(); }, 500);
    flushSave = () => { if (typeof notesView !== 'undefined') notesView.flush(); flushNotes(); };

    /* ---- skeleton ---- */
    panel = h('section');
    panel.id = 'ytx-panel';

    const header = h('div', 'ytx-header');
    header.appendChild(h('span', 'ytx-title', 'Transcript'));
    const refetchBtn = h('button', 'ytx-icon-btn', '⟳');
    refetchBtn.title = 'Refetch transcript';
    const pinBtn = h('button', 'ytx-icon-btn ytx-pin');
    pinBtn.appendChild(L.icons.pinIcon());
    const paintPin = () => {
      pinBtn.classList.toggle('is-on', !!video.pinned);
      pinBtn.title = video.pinned ? 'Pinned (in YT-transcriber/pinned). Click to unpin' : 'Pin: move this video into YT-transcriber/pinned';
    };
    paintPin();
    const libraryBtn = h('button', 'ytx-icon-btn', '⧉');
    libraryBtn.title = 'Open library';
    header.append(refetchBtn, pinBtn, libraryBtn);
    panel.appendChild(header);

    const tabsBar = h('div', 'ytx-tabs');
    const views = {
      transcript: h('div', 'ytx-view ytx-scroll ytx-transcript'),
      chat: h('div', 'ytx-view ytx-chat'),
      notes: h('div', 'ytx-view ytx-scroll ytx-notes'),
    };
    const tabBtns = {};
    const TABS = ['transcript', 'chat', 'notes'];
    let activeTab = 'transcript';
    for (const [key, label] of [['transcript', 'Transcript'], ['chat', 'Chat'], ['notes', 'Notes']]) {
      const b = h('button', 'ytx-tab', label);
      b.addEventListener('click', () => selectTab(key));
      tabBtns[key] = b;
      tabsBar.appendChild(b);
    }
    panel.appendChild(tabsBar);

    const body = h('div', 'ytx-body');
    body.append(views.transcript, views.chat, views.notes);
    panel.appendChild(body);

    function selectTab(key) {
      activeTab = key;
      for (const k of Object.keys(views)) {
        tabBtns[k].classList.toggle('is-active', k === key);
        views[k].classList.toggle('is-active', k === key);
      }
      // scrollHeight is 0 while hidden, so the chat's own scroll is a no-op — re-scroll on reveal
      if (key === 'chat') { const l = views.chat.querySelector('.ytx-chat-list'); if (l) l.scrollTop = l.scrollHeight; }
    }

    const toast = L.toast.createToaster(panel);

    /* ---- header actions ---- */
    refetchBtn.addEventListener('click', () => loadTranscript(true));
    libraryBtn.addEventListener('click', () => L.bus.call({ type: 'open-library' }).catch(() => {}));
    // Toggle: pin moves the video folder under YT-transcriber/pinned (with a summary .md); unpin moves it back.
    pinBtn.addEventListener('click', async () => {
      pinBtn.disabled = true;
      try {
        const settings = await L.db.getSettings();
        const wasPinned = !!video.pinned;
        if (wasPinned) await L.vault.unpin(settings, video);
        else await L.vault.pin(settings, video);
        await save();
        if (!live()) return;
        paintPin();
        toast(wasPinned ? 'Unpinned' : 'Pinned to knowledge base');
      } catch (e) {
        if (live()) toast(e.message === 'no-vault' ? 'Set the knowledge base folder in Library › Settings' : `Pin failed: ${e.message}`);
      } finally {
        pinBtn.disabled = false;
      }
    });

    /* ---- transcript tab ---- */
    function renderTranscriptLoading() {
      views.transcript.textContent = '';
      const st = h('div', 'ytx-state');
      st.append(h('div', 'ytx-spinner'), h('div', null, 'Loading transcript…'));
      views.transcript.appendChild(st);
    }

    function renderTranscriptError(e) {
      views.transcript.textContent = '';
      const st = h('div', 'ytx-state');
      const msg = e && e.message === 'no-captions'
        ? 'No captions on this video'
        : `Couldn't load transcript: ${e && e.message}`;
      st.appendChild(h('div', null, msg));
      const retry = h('button', 'ytx-btn', 'Retry');
      retry.addEventListener('click', () => loadTranscript(true));
      st.appendChild(retry);
      views.transcript.appendChild(st);
    }

    // Follow: highlight the segment the video is in and keep it centered (state survives re-renders).
    let followOn = false;
    let rows = []; // [{start, el}] from the last renderTranscript
    let currentRow = null;
    const followBar = h('div', 'ytx-follow-bar');
    const followBtn = h('button', 'ytx-follow', 'Follow');
    followBtn.title = 'Highlight and scroll to the part of the transcript being played';
    followBar.appendChild(followBtn);
    const paintFollow = () => followBtn.classList.toggle('is-on', followOn);
    function trackPlayback() {
      if (!followOn || !rows.length) return;
      const t = document.querySelector('video')?.currentTime ?? 0;
      let i = rows.findIndex((r) => r.start > t) - 1;
      if (i < -1) i = rows.length - 1; // past the last start → last row
      if (i < 0) i = 0;
      const row = rows[i].el;
      if (row === currentRow) return;
      if (currentRow) currentRow.classList.remove('is-current');
      currentRow = row;
      row.classList.add('is-current');
      const box = views.transcript;
      box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: 'smooth' });
    }
    followBtn.addEventListener('click', () => {
      followOn = !followOn;
      paintFollow();
      if (followOn) { currentRow = null; trackPlayback(); }
      else if (currentRow) { currentRow.classList.remove('is-current'); currentRow = null; }
    });
    paintFollow();
    // One listener per init; the <video> element is stable across SPA navs, so guard with live().
    document.querySelector('video')?.addEventListener('timeupdate', () => { if (live()) trackPlayback(); });

    function renderTranscript() {
      views.transcript.textContent = '';
      const grouped = video.transcript?.grouped ?? [];
      if (!grouped.length) return renderTranscriptError(new Error('no-captions'));
      views.transcript.appendChild(followBar);
      rows = [];
      currentRow = null;
      let clickTimer;
      for (const seg of grouped) {
        const row = h('div', 'ytx-row');
        rows.push({ start: seg.start, el: row });
        row.append(h('span', 'ytx-time', fmtTime(seg.start)), h('div', 'ytx-text', seg.text));
        row.addEventListener('click', () => {
          clearTimeout(clickTimer);
          clickTimer = setTimeout(() => seek(seg.start), 250); // defer so dblclick-copy doesn't also seek
        });
        row.addEventListener('dblclick', () => {
          clearTimeout(clickTimer);
          navigator.clipboard.writeText(`[${fmtTime(seg.start)}] ${seg.text}`)
            .then(() => toast('Copied'), () => toast('Copy failed'));
        });
        views.transcript.appendChild(row);
      }
    }

    async function loadTranscript(force = false) {
      if (video.transcript && !force) { renderTranscript(); return; }
      renderTranscriptLoading();
      try {
        const t = await L.transcript.fetchTranscript(videoId);
        if (!live()) return;
        video.transcript = {
          lang: t.lang,
          trackName: t.trackName,
          segments: t.segments,
          grouped: L.transcript.groupSegments(t.segments),
        };
        // The player response carries the authoritative title; use it when the DOM scrape came up empty.
        if (!L.vault.hasTitle(video) && L.vault.cleanTitle(t.title)) video.title = L.vault.cleanTitle(t.title);
        if (!video.channel && t.channel) video.channel = t.channel;
        await save();
        renderTranscript();
      } catch (e) {
        if (live()) renderTranscriptError(e);
      }
    }

    /* ---- knowledge base (disk) ---- */
    // Disk writes are not gen-guarded: an edit right before SPA nav must still land. Only the toast is.
    let vaultWarned = false;
    const disk = (fn) => L.db.getSettings().then((s) => fn(s)).catch((e) => {
      console.warn('[ytx] knowledge base', e);
      if (live() && !vaultWarned) { vaultWarned = true; toast(`Knowledge base: ${e.message}`); }
    });

    /* ---- chat tab (shared view: src/ui/chat.js) ---- */
    const chatView = L.chat.createChatView({
      video,
      save,
      disk,
      renderMd,
      toast,
      isLive: live,
      onSynced,
      segments: () => video.transcript?.grouped ?? [],
      settingsAction: () => {
        const b = h('button', 'ytx-btn', 'Open library');
        b.addEventListener('click', () => L.bus.call({ type: 'open-library' }).catch(() => {}));
        return b;
      },
    });
    views.chat.appendChild(chatView.root);
    const renderChat = () => chatView.refresh();
    const toggleWeb = () => chatView.toggleWeb();
    // Window capture: fires before YouTube's own document-level key handlers, which can swallow
    // Escape. ponytail: one dead listener per SPA nav, guarded by live().
    let hotkeysOn = true;
    L.db.getSettings().then((s) => { hotkeysOn = s.hotkeys !== false; }).catch(() => {});
    window.addEventListener('keydown', (e) => {
      if (!live()) return;
      if (e.key === 'Escape' && chatView.isBusy()) {
        e.preventDefault(); e.stopPropagation(); chatView.cancel();
      }
      if (!hotkeysOn) return;
      const hk = L.hotkeys.hotkeyId(e);
      if (!hk) return;
      e.preventDefault(); e.stopPropagation();
      if (hk === 'prevTab' || hk === 'nextTab') {
        const i = TABS.indexOf(activeTab);
        selectTab(TABS[(i + (hk === 'nextTab' ? 1 : TABS.length - 1)) % TABS.length]);
      } else if (hk === 'webSearch') {
        if (activeTab === 'chat') toggleWeb(); // only meaningful while chatting
      } else if (typeof notesView !== 'undefined') {
        selectTab('notes');
        notesView.setMode(hk === 'editMode' ? 'edit' : 'view');
      }
    }, true);

    /* ---- notes tab (shared view: src/ui/notes.js) ---- */
    const notesView = L.notes.createNotesView({
      video,
      fmtTime,
      renderMd,
      currentTime: () => document.querySelector('video')?.currentTime ?? 0,
      onSeek: seek,
      onChange: (card) => { notesDirty = true; diskDirty.add(card); saveSoon(); },
      onDelete: (card) => { diskDirty.delete(card); save(); disk((s) => L.vault.removeNote(s, video, card)); },
    });
    views.notes.appendChild(notesView.root);
    const renderNotes = () => notesView.refresh();

    /* ---- theme (follows YouTube's own dark attribute on <html>) ---- */
    const applyTheme = () => {
      panel.classList.toggle('ytx-dark', isDark());
      L.markdown.setDark(isDark()); // future mermaid renders follow the theme
    };
    applyTheme();
    themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

    /* ---- mount ---- */
    if (!live()) return;
    secondary.prepend(panel);
    // Fixed height = the player's height (non-theatre layout). Theatre mode moves #secondary below the
    // player; keep the last non-theatre height then instead of matching a full-width player.
    const flexy = document.querySelector('ytd-watch-flexy');
    const player = document.querySelector('#movie_player') || document.querySelector('video');
    const fitPlayer = () => {
      if (!live() || !player || (flexy && flexy.hasAttribute('theater'))) return;
      const hgt = Math.round(player.getBoundingClientRect().height);
      if (hgt > 200) panel.style.height = `${hgt}px`;
    };
    fitPlayer();
    if (player && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(fitPlayer);
      ro.observe(player);
      resizeObserver = ro;
    }
    selectTab('transcript');
    renderChat();
    renderNotes();
    loadTranscript(false);
    // Knowledge base folder set → files on disk are the truth. Runs after mount so a slow or
    // missing host never hides the panel; re-renders notes/chat when it lands.
    (async () => {
      const s0 = await L.db.getSettings();
      if (!L.vault.enabled(s0)) return;
      await L.vault.hydrate(s0, video);
      if (!live()) return;
      await save();
      paintPin();
      renderNotes();
      renderChat();
    })().catch((e) => {
      console.warn('[ytx] knowledge base', e);
      if (live()) { vaultWarned = true; toast(`Knowledge base: ${e.message}`); }
    });
  }

  window.addEventListener('yt-navigate-finish', () => { init(); });
  init();
})();
