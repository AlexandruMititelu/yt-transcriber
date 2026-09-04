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
  let mermaidP = null;
  let mermaidSeq = 0;
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
    const names = ['format', 'transcript', 'bus', 'db', 'llm', 'vault', 'picker', 'chatbar', 'notes', 'icons', 'hotkeys'];
    const UI = new Set(['picker', 'chatbar', 'notes', 'icons']);
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
    for (const name of ['picker', 'chatbar', 'notes']) {
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

  function ensureMermaid() {
    if (!mermaidP) {
      mermaidP = import(url('vendor/mermaid.min.js')).then(() => {
        globalThis.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark() ? 'dark' : 'neutral',
        });
        return globalThis.mermaid;
      }).catch((e) => { mermaidP = null; throw e; }); // don't cache a transient load failure
    }
    return mermaidP;
  }

  async function renderMermaidIn(root) {
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
          code.parentElement.replaceWith(wrap);
        } catch { /* invalid diagram: leave the fenced block visible */ }
      }
    } catch { /* mermaid failed to load: fenced blocks stay as code */ }
  }

  // [12:34] (assistant citations) and @12:34 (typed in notes) both become seek chips.
  const TS_RE = /(?:\[(\d{1,3}(?::[0-5]?\d){1,2})\]|@(\d{1,3}(?::[0-5]?\d){1,2}))/g;
  function linkifyTimestamps(root) {
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
        const sec = stamp.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
        const chip = h('button', 'ytx-ts', stamp);
        chip.type = 'button';
        chip.addEventListener('click', () => seek(sec));
        frag.append(chip);
        last = m.index + m[0].length;
      }
      frag.append(s.slice(last));
      node.replaceWith(frag);
    }
  }

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
      for (const d of diskDirty) disk((s) => L.vault.syncNote(s, video, d));
      diskDirty.clear();
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
      // scrollHeight is 0 while hidden, so renderChat's scroll is a no-op — re-scroll on reveal
      if (key === 'chat') chatList.scrollTop = chatList.scrollHeight;
    }

    function toast(msg, linkUrl) {
      panel.querySelectorAll('.ytx-toast').forEach((t) => t.remove());
      const t = h('div', 'ytx-toast');
      t.appendChild(h('span', null, msg));
      if (linkUrl) {
        const a = h('a', null, 'Open');
        a.href = linkUrl;
        a.target = '_blank';
        a.rel = 'noreferrer';
        t.appendChild(a);
      }
      panel.appendChild(t);
      setTimeout(() => t.remove(), 1700); // css fade runs 1.6s
    }

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

    /* ---- chat tab ---- */
    const chatList = h('div', 'ytx-chat-list');
    const composer = h('div', 'ytx-composer');
    const chatTa = h('textarea');
    chatTa.placeholder = 'Ask about this video…';
    chatTa.rows = 1;
    const sendBtn = h('button', 'ytx-send', '↑');
    sendBtn.title = 'Send';
    composer.append(chatTa, sendBtn);

    const cur = () => video.chats.find((c) => c.id === video.activeChatId) ?? null;
    function ensureChat() {
      let c = cur();
      if (!c) { c = L.db.newChat(); video.chats.push(c); video.activeChatId = c.id; }
      return c;
    }
    // Switching drops the empty, never-sent chat the user is leaving.
    function switchTo(id) {
      if (cancelChat) cancelChat();
      video.chats = video.chats.filter((c) => c.messages.length || c.id === id);
      video.activeChatId = id;
      save();
      renderChat();
    }
    const chatBar = L.chatbar.createChatBar({
      chats: () => video.chats,
      activeId: () => video.activeChatId,
      onSelect: switchTo,
      onNew: () => {
        if (cur() && !cur().messages.length) return;
        const c = L.db.newChat();
        video.chats.push(c);
        switchTo(c.id);
        chatTa.focus();
      },
      onRename: (title) => {
        const c = cur();
        if (!c) return;
        c.title = title;
        c.updatedAt = Date.now();
        save();
        disk((s) => L.vault.syncChat(s, video, c));
      },
      onDelete: () => {
        const c = cur();
        if (!c) return;
        chatList.replaceChildren(L.chatbar.confirmBox({
          text: `Delete "${c.title}"? This removes it from the knowledge base too.`,
          onCancel: renderChat,
          onConfirm: () => {
            if (cancelChat) cancelChat();
            video.chats = video.chats.filter((x) => x.id !== c.id);
            video.activeChatId = video.chats.at(-1)?.id ?? null;
            save();
            disk((s) => L.vault.removeChat(s, video, c));
            renderChat();
          },
        }));
      },
    });
    views.chat.append(chatBar.root, chatList, composer, L.picker.createPicker({ isLive: live }));

    let chatBusy = false;
    function setChatBusy(b) {
      chatBusy = b;
      chatTa.disabled = b;
      sendBtn.disabled = b;
      sendBtn.textContent = b ? '…' : '↑';
    }

    function renderAssistant(content) {
      const md = h('div', 'ytx-md');
      // FORBID_TAGS img: a prompt-injected transcript could make the LLM emit an image URL that exfiltrates chat content on fetch
      md.innerHTML = globalThis.DOMPurify.sanitize(globalThis.marked.parse(content), { FORBID_TAGS: ['img'] });
      for (const a of md.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
      linkifyTimestamps(md);
      renderMermaidIn(md);
      return md;
    }

    function copyBtn(text) {
      const b = h('button', 'ytx-copy', '⧉');
      b.title = 'Copy message';
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          b.textContent = '✓';
          setTimeout(() => { b.textContent = '⧉'; }, 1200);
        }).catch(() => toast('Copy failed'));
      });
      return b;
    }

    function renderChat() {
      chatBar.refresh();
      chatList.textContent = '';
      for (const m of cur()?.messages ?? []) {
        const bubble = h('div', `ytx-msg ytx-msg-${m.role}`);
        if (m.role === 'assistant') bubble.append(renderAssistant(m.content), copyBtn(m.content));
        else bubble.textContent = m.content;
        chatList.appendChild(bubble);
      }
      chatList.scrollTop = chatList.scrollHeight;
    }

    function chatErrorBubble(e) {
      const bubble = h('div', 'ytx-msg ytx-msg-system');
      if (e && e.message === 'no-api-key') {
        bubble.append('Add your API key in Settings. ');
        const b = h('button', 'ytx-btn', 'Open library');
        b.addEventListener('click', () => L.bus.call({ type: 'open-library' }).catch(() => {}));
        bubble.appendChild(b);
      } else {
        bubble.textContent = (e && e.message) || 'Something went wrong';
      }
      chatList.appendChild(bubble);
      chatList.scrollTop = chatList.scrollHeight;
    }

    // First reply in a "New chat" → ask the model for a short title (best effort, never blocks).
    function autoTitle(chat, settings) {
      if (chat.title !== L.db.NEW_CHAT_TITLE || chat.messages.length !== 2) return;
      L.llm.titleChat({ settings, messages: chat.messages }).then((t) => {
        if (!t || chat.title !== L.db.NEW_CHAT_TITLE) return;
        chat.title = t;
        chat.updatedAt = Date.now();
        save();
        if (live()) chatBar.refresh();
        disk((s) => L.vault.syncChat(s, video, chat));
      }).catch((e) => console.warn('[ytx] title', e));
    }

    let chatGen = 0; // bumped by cancelChat; a reply for an older gen is dropped
    let cancelChat = null;
    async function sendChat() {
      const text = chatTa.value.trim();
      if (!text || chatBusy) return;
      setChatBusy(true); // synchronously, before any await, so a second Enter can't start a concurrent request
      const gen = ++chatGen;
      chatTa.value = '';
      const chat = ensureChat();
      chat.messages.push({ role: 'user', content: text, ts: Date.now() });
      chat.updatedAt = Date.now();
      await save();
      if (!live()) return;
      renderChat();
      const pending = h('div', 'ytx-msg ytx-msg-assistant ytx-pending', 'Thinking…');
      chatList.appendChild(pending);
      chatList.scrollTop = chatList.scrollHeight;
      // ponytail: background fetch still completes; we just drop the reply. Abort via port if it matters.
      cancelChat = () => { chatGen++; pending.remove(); setChatBusy(false); cancelChat = null; };
      try {
        const settings = await L.db.getSettings();
        const system = L.llm.buildSystemPrompt({
          title: video.title,
          channel: video.channel,
          segments: video.transcript?.grouped ?? [],
          aboutMe: settings.aboutMe,
          tone: settings.tone,
          webSearch: !!settings.webSearch,
        });
        const reply = await L.llm.chat({
          settings,
          system,
          messages: chat.messages.map(({ role, content }) => ({ role, content })),
        });
        if (!live() || gen !== chatGen) return;
        chat.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
        chat.updatedAt = Date.now();
        await save();
        disk((s) => L.vault.syncChat(s, video, chat));
        autoTitle(chat, settings);
        if (cur() === chat) renderChat();
      } catch (e) {
        if (live() && gen === chatGen) chatErrorBubble(e);
      } finally {
        if (gen === chatGen) {
          cancelChat = null;
          pending.remove(); // no-op if renderChat already wiped the list on success
          if (live()) setChatBusy(false);
        }
      }
    }
    sendBtn.addEventListener('click', sendChat);
    // Window capture: fires before YouTube's own document-level key handlers, which can swallow
    // Enter/Escape. Escape is checked regardless of target: the textarea is disabled while busy,
    // so focus leaves the panel. ponytail: one dead listener per SPA nav, guarded by live().
    let hotkeysOn = true;
    L.db.getSettings().then((s) => { hotkeysOn = s.hotkeys !== false; }).catch(() => {});
    window.addEventListener('keydown', (e) => {
      if (!live()) return;
      if (e.key === 'Enter' && !e.shiftKey && e.target === chatTa) {
        e.preventDefault(); e.stopPropagation(); sendChat();
      } else if (e.key === 'Escape' && cancelChat) {
        e.preventDefault(); e.stopPropagation(); cancelChat();
      }
      if (!hotkeysOn) return;
      const hk = L.hotkeys.hotkeyId(e);
      if (!hk) return;
      e.preventDefault(); e.stopPropagation();
      if (hk === 'prevTab' || hk === 'nextTab') {
        const i = TABS.indexOf(activeTab);
        selectTab(TABS[(i + (hk === 'nextTab' ? 1 : TABS.length - 1)) % TABS.length]);
      } else if (typeof notesView !== 'undefined') {
        selectTab('notes');
        notesView.setMode(hk === 'editMode' ? 'edit' : 'view');
      }
    }, true);

    /* ---- notes tab (shared view: src/ui/notes.js) ---- */
    const notesView = L.notes.createNotesView({
      video,
      fmtTime,
      renderMd: renderAssistant,
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
      // keep future mermaid renders in sync with the theme (already-rendered SVGs keep theirs)
      if (mermaidP) {
        mermaidP.then((m) => m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark() ? 'dark' : 'neutral',
        })).catch(() => {});
      }
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
