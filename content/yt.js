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
  let theaterObserver = null;
  let flushSave = null; // pending debounced note-save; flushed on teardown so edits survive SPA nav
  let notesView = null; // current init's notes view (declared up front: flushSave/hotkeys reference it)

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
    if (theaterObserver) { theaterObserver.disconnect(); theaterObserver = null; }
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
    const rec = await L.db.getVideo(videoId);
    const video = rec ?? L.db.blankVideo(videoId, meta.title, meta.channel);
    let saved = !!rec; // has a DB record → no "+" button
    if (!live()) return;
    if (!L.vault.hasTitle(video) && meta.title) video.title = meta.title;
    if (!video.channel && meta.channel) video.channel = meta.channel;

    // Save gate: merely watching a video must not create a record. Once the user keeps / pins /
    // chats / takes a note the record (transcript included) is written on every save.
    const keep = () => !!video.kept || !!video.pinned || video.chats.some((c) => c.messages.length) || video.notes.cards.length > 0;
    const save = () => {
      if (!keep()) return Promise.resolve();
      return L.db.saveVideo(video).then(() => { saved = true; paintAdd(); }, (e) => console.warn('[ytx] save failed', e));
    };
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
    flushSave = () => { if (notesView) notesView.flush(); flushNotes(); };

    /* ---- skeleton ---- */
    panel = h('section');
    panel.id = 'ytx-panel';

    const header = h('div', 'ytx-header');
    const brand = h('span', 'ytx-title');
    const logo = h('img', 'ytx-logo');
    logo.alt = '';
    logo.src = url('assets/logo-light.svg');
    brand.append(logo, 'YT-Trans');
    header.appendChild(brand);
    const addBtn = h('button', 'ytx-icon-btn');
    addBtn.appendChild(L.icons.plusIcon());
    addBtn.title = 'Save this video to the library';
    addBtn.setAttribute('aria-label', 'Save this video to the library');
    function paintAdd() { addBtn.hidden = saved; }
    paintAdd();
    addBtn.addEventListener('click', async () => {
      video.kept = true;
      await save();
      if (live()) toast('Saved to library');
    });
    const refetchBtn = h('button', 'ytx-icon-btn');
    refetchBtn.appendChild(L.icons.refreshIcon());
    refetchBtn.title = 'Refetch transcript';
    refetchBtn.setAttribute('aria-label', 'Refetch transcript');
    const pinBtn = h('button', 'ytx-icon-btn ytx-pin');
    pinBtn.appendChild(L.icons.pinIcon());
    const paintPin = () => {
      pinBtn.classList.toggle('is-on', !!video.pinned);
      pinBtn.title = video.pinned ? 'Pinned (in YT-transcriber/pinned). Click to unpin' : 'Pin: move this video into YT-transcriber/pinned';
    };
    paintPin();
    pinBtn.setAttribute('aria-label', 'Pin');
    const libraryBtn = h('button', 'ytx-icon-btn');
    libraryBtn.appendChild(L.icons.libraryIcon());
    libraryBtn.title = 'Open library';
    libraryBtn.setAttribute('aria-label', 'Open library');
    header.append(addBtn, refetchBtn, pinBtn, libraryBtn);
    panel.appendChild(header);

    const tabsBar = h('div', 'ytx-tabs');
    tabsBar.setAttribute('role', 'tablist');
    const views = {
      transcript: h('div', 'ytx-view ytx-transcript'),
      chat: h('div', 'ytx-view ytx-chat-view'),
      notes: h('div', 'ytx-view ytx-scroll ytx-notes-view'),
    };
    const tabBtns = {};
    const TABS = ['transcript', 'chat', 'notes'];
    let activeTab = 'transcript';
    const TAB_LABEL = { transcript: 'Transcript', chat: 'Chat', notes: 'Notes' };
    for (const key of TABS) {
      const b = h('button', 'ytx-tab', TAB_LABEL[key]);
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => selectTab(key));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const i = TABS.indexOf(activeTab);
        selectTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]);
        tabBtns[activeTab].focus();
      });
      tabBtns[key] = b;
      views[key].setAttribute('role', 'tabpanel');
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
        tabBtns[k].setAttribute('aria-selected', k === key ? 'true' : 'false');
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
      st.appendChild(h('div', null, L.transcript.explainFailure(e)));
      const retry = h('button', 'ytx-btn', 'Retry');
      retry.addEventListener('click', () => loadTranscript(true));
      st.appendChild(retry);
      views.transcript.appendChild(st);
    }

    // Toolbar: search · track/translate menu · copy all · Follow. Follow highlights the segment being
    // played and keeps it centered; a manual scroll pauses it. State survives re-renders.
    let followOn = false;
    L.db.getSettings().then((s) => { followOn = !!s.follow; paintFollow(); }).catch(() => {});
    let rows = []; // [{start, el}] from the last renderTranscript
    let currentRow = null;
    let currentCue = null;
    let query = '';
    const bar = h('div', 'ytx-follow-bar');
    // Toolbar sits above the scrolling row list (a sibling, not sticky: nothing can scroll behind it).
    const trList = h('div', 'ytx-scroll ytx-tr-list');
    const search = h('input', 'ytx-tr-search');
    search.type = 'search';
    search.placeholder = 'Search transcript…';
    search.setAttribute('aria-label', 'Search transcript');
    search.addEventListener('keydown', (e) => { if (!e.altKey) e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; applyFilter(); search.blur(); } });
    search.addEventListener('input', applyFilter);
    const trackBtn = h('button', 'ytx-tr-track');
    trackBtn.type = 'button';
    trackBtn.title = 'Caption track / translate';
    const trackMenu = h('div', 'ytx-tr-menu');
    const trackWrap = h('div', 'ytx-tr-trackwrap');
    trackWrap.append(trackBtn, trackMenu);
    const copyAll = h('button', 'ytx-icon-btn ytx-tr-copy');
    copyAll.appendChild(L.icons.copyIcon());
    copyAll.title = 'Copy whole transcript';
    copyAll.setAttribute('aria-label', 'Copy whole transcript');
    copyAll.addEventListener('click', () => {
      const text = (video.transcript?.grouped ?? []).map((g) => `[${fmtTime(g.start)}] ${g.text}`).join('\n');
      navigator.clipboard.writeText(text).then(() => toast('Transcript copied'), () => toast('Copy failed'));
    });
    const followBtn = h('button', 'ytx-follow', 'Follow');
    followBtn.title = 'Highlight and scroll to the part of the transcript being played';
    followBtn.setAttribute('aria-pressed', 'false');
    bar.append(search, trackWrap, copyAll, followBtn);
    function paintFollow() { followBtn.classList.toggle('is-on', followOn); followBtn.setAttribute('aria-pressed', followOn ? 'true' : 'false'); }
    // Query matches are wrapped in <mark>; text nodes are built by hand (never innerHTML).
    function highlight(el, text) {
      let i = 0;
      if (query) {
        const low = text.toLowerCase();
        for (let j = low.indexOf(query); j >= 0; j = low.indexOf(query, i)) {
          if (j > i) el.append(text.slice(i, j));
          el.append(h('mark', 'ytx-hl', text.slice(j, j + query.length)));
          i = j + query.length;
        }
      }
      el.append(text.slice(i));
    }
    // One span per caption cue (older records without cues: one span for the row); click seeks to the cue.
    function paintText(r) {
      const el = r.textEl;
      el.textContent = '';
      const cues = r.cues?.length ? r.cues : [{ start: r.start, text: r.text }];
      r.cueEls = cues.map((c, k) => {
        const span = h('span', 'ytx-cue');
        highlight(span, c.text);
        span.addEventListener('click', (e) => { e.stopPropagation(); seek(c.start); });
        el.append(span, k < cues.length - 1 ? ' ' : '');
        return span;
      });
      el.append(r.acts);
    }
    function applyFilter() {
      query = search.value.trim().toLowerCase();
      let n = 0;
      for (const r of rows) {
        const hit = !query || r.text.toLowerCase().includes(query);
        r.el.hidden = !hit;
        if (hit) n++;
        paintText(r);
      }
      for (const c of views.transcript.querySelectorAll('.ytx-chapter')) c.hidden = !!query;
      search.classList.toggle('is-empty', !!query && n === 0);
    }
    let programmaticScroll = 0;
    function trackPlayback() {
      if (!followOn || !rows.length) return;
      const t = document.querySelector('video')?.currentTime ?? 0;
      let i = rows.findIndex((r) => r.start > t) - 1;
      if (i < -1) i = rows.length - 1; // past the last start → last row
      if (i < 0) i = 0;
      const r = rows[i];
      const row = r.el;
      let k = r.cueEls.length - 1;
      if (r.cues?.length) { k = r.cues.findIndex((c) => c.start > t) - 1; if (k < -1) k = r.cues.length - 1; if (k < 0) k = 0; }
      const cue = r.cueEls[k];
      if (cue !== currentCue) { currentCue?.classList.remove('is-now'); currentCue = cue; cue?.classList.add('is-now'); }
      if (row === currentRow) return;
      if (currentRow) currentRow.classList.remove('is-current');
      currentRow = row;
      row.classList.add('is-current');
      const box = trList;
      programmaticScroll = Date.now();
      box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: 'smooth' });
    }
    const setFollow = (on) => {
      followOn = on;
      paintFollow();
      L.db.saveSettings({ follow: on }).catch(() => {});
      if (on) { currentRow = null; trackPlayback(); }
      else { currentRow?.classList.remove('is-current'); currentRow = null; currentCue?.classList.remove('is-now'); currentCue = null; }
    };
    followBtn.addEventListener('click', () => setFollow(!followOn));
    // A wheel / touch scroll by the user pauses Follow (the smooth scroll we trigger does not fire these).
    const userScrolled = () => { if (followOn && Date.now() - programmaticScroll > 50) { setFollow(false); toast('Follow paused'); } };
    trList.addEventListener('wheel', userScrolled, { passive: true });
    trList.addEventListener('touchmove', userScrolled, { passive: true });
    paintFollow();
    // One listener per init; the <video> element is stable across SPA navs, so guard with live().
    document.querySelector('video')?.addEventListener('timeupdate', () => { if (live()) trackPlayback(); });

    const TRANSLATE = ['en', 'ro', 'nl', 'de', 'fr', 'es', 'it', 'pt'];
    function paintTrack() {
      const t = video.transcript;
      trackBtn.textContent = t ? (t.trackName || t.lang || '?') : '';
      trackBtn.hidden = !t || ((t.tracks?.length ?? 0) < 2 && !t.translate && !t.tracks?.length);
    }
    function renderTrackMenu() {
      trackMenu.textContent = '';
      const t = video.transcript;
      if (!t) return;
      const item = (label, on, cb) => {
        const b = h('button', `ytx-tr-item${on ? ' is-on' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => { closeTrackMenu(); cb(); });
        trackMenu.append(b);
      };
      trackMenu.append(h('div', 'ytx-tr-group', 'Captions'));
      for (const tr of t.tracks ?? []) {
        item(`${tr.name}${tr.asr ? ' (auto)' : ''}`, !t.translate && tr.lang === t.track?.lang && !!tr.asr === !!t.track?.asr,
          () => loadTranscript(true, { track: tr }));
      }
      trackMenu.append(h('div', 'ytx-tr-group', 'Translate to'));
      for (const lang of TRANSLATE) item(lang.toUpperCase(), t.translate === lang, () => loadTranscript(true, { track: t.track, translate: lang }));
    }
    const onDocTrack = (e) => { if (!e.composedPath().includes(trackWrap)) closeTrackMenu(); };
    function closeTrackMenu() { trackMenu.classList.remove('is-open'); window.removeEventListener('pointerdown', onDocTrack, true); }
    trackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (trackMenu.classList.contains('is-open')) return closeTrackMenu();
      renderTrackMenu();
      trackMenu.classList.add('is-open');
      window.addEventListener('pointerdown', onDocTrack, true);
    });

    function renderTranscript() {
      views.transcript.textContent = '';
      trList.textContent = '';
      const grouped = video.transcript?.grouped ?? [];
      if (!grouped.length) return renderTranscriptError(new Error('no-captions'));
      views.transcript.append(bar, trList);
      paintTrack();
      rows = [];
      currentRow = null;
      currentCue = null;
      const chapters = video.transcript?.chapters ?? [];
      let ci = 0;
      for (const seg of grouped) {
        while (ci < chapters.length && chapters[ci].start <= seg.start) {
          const c = chapters[ci++];
          const head = h('div', 'ytx-chapter');
          head.append(h('span', 'ytx-time', fmtTime(c.start)), h('span', 'ytx-chapter-title', c.title));
          head.addEventListener('click', () => seek(c.start));
          trList.appendChild(head);
        }
        const row = h('div', 'ytx-row');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const acts = h('span', 'ytx-row-acts');
        const copy = h('button', 'ytx-row-act');
        copy.appendChild(L.icons.copyIcon());
        copy.type = 'button';
        copy.title = 'Copy line';
        copy.setAttribute('aria-label', 'Copy line');
        copy.addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(`[${fmtTime(seg.start)}] ${seg.text}`).then(() => toast('Copied'), () => toast('Copy failed'));
        });
        const ask = h('button', 'ytx-row-act');
        ask.appendChild(L.icons.chatIcon());
        ask.type = 'button';
        ask.title = 'Ask about this in Chat';
        ask.setAttribute('aria-label', 'Ask about this in Chat');
        ask.addEventListener('click', (e) => {
          e.stopPropagation();
          selectTab('chat');
          chatView.prefill(`> [${fmtTime(seg.start)}] ${seg.text}\n\n`);
        });
        acts.append(copy, ask);
        // Actions live at the end of the text (inline), so they never cover words.
        const textEl = h('div', 'ytx-text');
        rows.push({ start: seg.start, el: row, text: seg.text, cues: seg.cues, textEl, acts });
        row.append(h('span', 'ytx-time', fmtTime(seg.start)), textEl);
        row.addEventListener('click', () => seek(seg.start));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seek(seg.start); } });
        trList.appendChild(row);
      }
      applyFilter();
    }

    async function loadTranscript(force = false, pick = {}) {
      // Records saved before cues existed are refetched once so Follow can highlight per caption line.
      if (video.transcript && !force && video.transcript.grouped?.[0]?.cues) { renderTranscript(); return; }
      renderTranscriptLoading();
      try {
        const s = await L.db.getSettings();
        const t = await L.transcript.fetchTranscript(videoId, { lang: s.lang || 'en', track: pick.track, translate: pick.translate });
        if (!live()) return;
        video.transcript = {
          lang: t.lang,
          trackName: t.trackName,
          track: t.track,
          translate: t.translate,
          tracks: t.tracks,
          duration: t.duration,
          chapters: t.chapters,
          grouped: L.transcript.groupSegments(t.segments), // raw segments are not kept: grouped is all we use
        };
        video.transcriptFile = null; // Transcript.md must be rewritten for the new track/language
        // The player response carries the authoritative title; use it when the DOM scrape came up empty.
        if (!L.vault.hasTitle(video) && L.vault.cleanTitle(t.title)) video.title = L.vault.cleanTitle(t.title);
        if (!video.channel && t.channel) video.channel = t.channel;
        await save();
        renderTranscript();
        // Transcript.md only for kept videos; vault.ensureDirs writes it when notes/chats land.
        if (keep()) disk((st) => L.vault.syncTranscript(st, video));
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
      onFrame: () => chatFrame().catch((e) => { toast(`Frame: ${e.message}`); return null; }),
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
      } else if (hk === 'focusChat') {
        selectTab('chat'); chatView.focus();
      } else if (hk === 'findTranscript') {
        selectTab('transcript'); search.focus();
      } else if (hk === 'newNote') {
        selectTab('notes'); notesView.addNote('note');
      } else if (hk === 'quickNote') {
        selectTab('notes'); notesView.addNote('quick');
      } else if (hk === 'toggleNote') {
        selectTab('notes'); notesView.toggle();
      } else if (hk === 'prevNote' || hk === 'nextNote') {
        selectTab('notes'); notesView.move(hk === 'nextNote' ? 1 : -1);
      } else if (hk === 'focusVideo') {
        (document.querySelector('#movie_player') || document.querySelector('video'))?.focus();
      } else {
        selectTab('notes');
        notesView.setMode(hk === 'editMode' ? 'edit' : 'view');
      }
    }, true);

    /* ---- notes tab (shared view: src/ui/notes.js) ---- */
    // Frame capture: current video frame → <video>/attachments/<m-ss>.jpg in the vault, embed pasted into the note.
    function grabFrame() {
      const v = document.querySelector('video');
      if (!v || !v.videoWidth) { toast('No video frame yet'); return null; }
      const c = document.createElement('canvas');
      const w = Math.min(1280, v.videoWidth);
      c.width = w;
      c.height = Math.round(v.videoHeight * (w / v.videoWidth));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      try { return { dataUrl: c.toDataURL('image/jpeg', 0.85), sec: v.currentTime }; } catch { toast('Frame capture blocked by the player'); return null; }
    }
    async function captureFrame() {
      const f = grabFrame();
      if (!f) return null;
      const s = await L.db.getSettings();
      if (!L.vault.enabled(s)) { toast('Set the knowledge base folder in Library › Settings to save frames'); return null; }
      const embed = await L.vault.saveFrame(s, video, f.dataUrl, f.sec);
      return { embed, sec: f.sec };
    }
    // Chat camera: the frame goes to the model; saved to the vault too when a folder is set.
    async function chatFrame() {
      const f = grabFrame();
      if (!f) return null;
      const s = await L.db.getSettings();
      if (L.vault.enabled(s)) f.embed = await L.vault.saveFrame(s, video, f.dataUrl, f.sec).catch(() => undefined);
      return f;
    }
    notesView = L.notes.createNotesView({
      video,
      fmtTime,
      renderMd,
      currentTime: () => document.querySelector('video')?.currentTime ?? 0,
      onSeek: seek,
      onChange: (card) => { notesDirty = true; diskDirty.add(card); saveSoon(); },
      onDelete: (card) => { diskDirty.delete(card); save(); disk((s) => L.vault.removeNote(s, video, card)); },
      onUndo: (card, idx) => toast('Deleted', { action: { label: 'Undo', onClick: () => {
        video.notes.cards.splice(Math.min(idx, video.notes.cards.length), 0, card);
        notesDirty = true; diskDirty.add(card); flushNotes(); notesView.refresh();
      } } }),
      onFrame: () => captureFrame().catch((e) => { toast(`Frame: ${e.message}`); return null; }),
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
      if (!live() || !player) return;
      const theater = !!(flexy && flexy.hasAttribute('theater'));
      panel.classList.toggle('is-theater', theater);
      if (theater) { panel.style.height = ''; return; } // #secondary sits below a full-width player: cap by CSS instead
      const hgt = Math.round(player.getBoundingClientRect().height);
      if (hgt > 200) panel.style.height = `${hgt}px`;
    };
    if (flexy && 'MutationObserver' in window) {
      const mo = new MutationObserver(fitPlayer);
      mo.observe(flexy, { attributes: true, attributeFilter: ['theater'] });
      theaterObserver = mo;
    }
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
