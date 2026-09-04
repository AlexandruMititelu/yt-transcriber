// Chat tab — shared by the YouTube panel and the library page. Streams replies, stop/retry,
// prompt presets, per-message usage, edit & resend, scroll-aware list. Classes ytx-chat-*, ytx-msg-*.
import * as db from '../lib/db.js';
import * as llm from '../lib/llm.js';
import * as vault from '../lib/vault.js';
import { fmtTime } from '../lib/format.js';
import { createPicker } from './picker.js';
import { createChatBar, confirmBox } from './chatbar.js';
import { globeIcon, copyIcon, checkIcon, cameraIcon } from './icons.js';
import { keysFor } from '../../config/hotkeys.js';
import { PROMPTS, parsePrompts } from '../../config/prompts.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const autosize = (ta, max = 160) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, max)}px`; };
const fmtClock = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// opts: { video, save(), disk(fn), renderMd(text) → el, toast(msg), isLive?(), onSynced?(r),
//         segments() → grouped, settingsAction() → el ("open settings" control for the no-key error) }
// → { root, refresh(), toggleWeb(), cancel(), focus(), prefill(text), isBusy() }
export function createChatView(opts) {
  const { video, save, disk, renderMd, toast, segments } = opts;
  const live = opts.isLive ?? (() => true);
  const onSynced = opts.onSynced ?? (() => {});

  const root = h('div', 'ytx-chat');
  const list = h('div', 'ytx-chat-list');
  const newPill = h('button', 'ytx-chat-new', '↓ New reply');
  newPill.type = 'button';
  newPill.addEventListener('click', () => scrollBottom(true));
  const composer = h('div', 'ytx-chat-composer');
  const presets = h('div', 'ytx-chat-presets');
  const ta = h('textarea', 'ytx-chat-ta');
  ta.placeholder = 'Ask about this video…';
  ta.title = 'Enter to send, Shift+Enter for a new line';
  ta.rows = 1;
  ta.setAttribute('aria-label', 'Message');
  const sendBtn = h('button', 'ytx-chat-send', '↑');
  sendBtn.type = 'button';
  sendBtn.title = 'Send (Enter)';
  sendBtn.setAttribute('aria-label', 'Send');
  const webBtn = h('button', 'ytx-chat-web');
  webBtn.type = 'button';
  webBtn.appendChild(globeIcon());
  const paintWeb = (on) => {
    webBtn.classList.toggle('is-on', !!on);
    webBtn.title = (on ? 'Web search on' : 'Web search off') + ` (${keysFor('webSearch')})`;
    webBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    webBtn.setAttribute('aria-label', 'Web search');
  };
  db.getSettings().then((s) => paintWeb(s.webSearch)).catch(() => {});
  async function toggleWeb() {
    const s = await db.getSettings();
    const on = !s.webSearch;
    await db.saveSettings({ webSearch: on });
    if (!live()) return;
    paintWeb(on);
    toast(on ? 'Web search on' : 'Web search off');
  }
  webBtn.addEventListener('click', toggleWeb);
  // Frame capture (watch page only): opts.onFrame() → {dataUrl, sec, embed?} | null, attached to the next message.
  let frame = null;
  const attach = h('div', 'ytx-chat-attach');
  attach.hidden = true;
  function setFrame(f) {
    frame = f;
    attach.textContent = '';
    attach.hidden = !f;
    if (!f) return;
    const img = h('img', 'ytx-chat-attach-img');
    img.src = f.dataUrl;
    img.alt = 'Captured frame';
    const x = h('button', 'ytx-chat-attach-x', '✕');
    x.type = 'button';
    x.title = 'Remove frame';
    x.setAttribute('aria-label', 'Remove frame');
    x.addEventListener('click', () => setFrame(null));
    attach.append(img, h('span', 'ytx-chat-attach-at', `@${fmtTime(f.sec)}`), x);
  }
  const camBtn = h('button', 'ytx-chat-web ytx-chat-cam');
  camBtn.type = 'button';
  camBtn.title = 'Attach the current video frame';
  camBtn.setAttribute('aria-label', 'Attach the current video frame');
  camBtn.appendChild(cameraIcon());
  camBtn.addEventListener('click', async () => {
    const f = await opts.onFrame();
    if (f && live()) { setFrame(f); ta.focus(); }
  });
  const pill = h('div', 'ytx-chat-pill');
  const tools = h('div', 'ytx-chat-tools');
  let lastSettings = null; // cached for the empty-state hint; picker's onChange keeps it fresh
  const ctx = h('span', 'ytx-chat-ctx');
  tools.append(ctx, h('span', 'ytx-chat-spacer'), createPicker({
    isLive: live,
    onChange: (s) => { lastSettings = s; if (!cur()?.messages.length) refresh(); else paintCtx(); },
  }), webBtn, sendBtn);
  const modelId = () => (lastSettings ? llm.parseModel(lastSettings.model).id : '');
  // Transcript past the model's cap → left out of the prompt, model searches it with llm.transcriptTools.
  const retrieval = (id) => llm.promptCoverage(segments(), llm.contextCap(id)) < 1;
  const sysPrompt = (id, s = {}) => llm.buildSystemPrompt({
    title: video.title, channel: video.channel, segments: segments(), aboutMe: s.aboutMe, tone: s.tone,
    webSearch: !!s.webSearch, cap: llm.contextCap(id), retrieval: retrieval(id),
    duration: video.transcript?.duration ?? 0, chapters: video.transcript?.chapters ?? [],
  });
  // Context meter: last reply's real usage, else a chars/3.5 estimate of the system prompt.
  function paintCtx() {
    const id = modelId();
    const win = llm.contextWindow(id);
    const last = [...(cur()?.messages ?? [])].reverse().find((m) => m.usage);
    const used = last ? last.usage.in + last.usage.out : Math.round(sysPrompt(id).length / llm.CHARS_PER_TOKEN);
    const pct = 100 * used / win;
    ctx.textContent = `${last ? '' : '~'}${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
    ctx.title = `${last ? 'Context used by the last reply' : 'Estimated prompt size'}: ${llm.fmtK(used)} of ${llm.fmtK(win)} tokens`;
    ctx.classList.toggle('is-warn', used / win > 0.8);
  }
  pill.append(ta, tools);
  composer.append(presets, pill);

  /* ---- chats ---- */
  const cur = () => video.chats.find((c) => c.id === video.activeChatId) ?? null;
  function ensureChat() {
    let c = cur();
    if (!c) { c = db.newChat(); video.chats.push(c); video.activeChatId = c.id; }
    return c;
  }
  const sync = (chat) => disk((s) => vault.syncChat(s, video, chat).then(onSynced));
  // Switching drops the empty, never-sent chat the user is leaving.
  function switchTo(id) {
    cancel();
    video.chats = video.chats.filter((c) => c.messages.length || c.id === id);
    video.activeChatId = id;
    save();
    refresh();
  }
  const bar = createChatBar({
    chats: () => video.chats,
    activeId: () => video.activeChatId,
    onSelect: switchTo,
    onNew: () => {
      if (cur() && !cur().messages.length) return;
      const c = db.newChat();
      video.chats.push(c);
      switchTo(c.id);
      ta.focus();
    },
    onRename: (title) => {
      const c = cur();
      if (!c) return;
      c.title = title;
      c.updatedAt = Date.now();
      save();
      sync(c);
    },
    onDelete: () => {
      const c = cur();
      if (!c) return;
      list.replaceChildren(confirmBox({
        text: `Delete "${c.title}"? This removes it from the knowledge base too.`,
        onCancel: refresh,
        onConfirm: () => {
          cancel();
          video.chats = video.chats.filter((x) => x.id !== c.id);
          video.activeChatId = video.chats.at(-1)?.id ?? null;
          save();
          disk((s) => vault.removeChat(s, video, c));
          refresh();
        },
      }));
    },
  });
  root.append(bar.root, list, newPill, composer);

  /* ---- scrolling: only follow the bottom when the user is already there ---- */
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  function scrollBottom(force = false) {
    if (force || nearBottom()) { list.scrollTop = list.scrollHeight; newPill.classList.remove('is-on'); }
    else newPill.classList.add('is-on');
  }
  list.addEventListener('scroll', () => { if (nearBottom()) newPill.classList.remove('is-on'); });

  /* ---- bubbles ---- */
  function copyBtn(text) {
    const b = h('button', 'ytx-msg-copy');
    b.type = 'button';
    b.title = 'Copy message';
    b.setAttribute('aria-label', 'Copy message');
    b.appendChild(copyIcon());
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        b.replaceChildren(checkIcon());
        setTimeout(() => b.replaceChildren(copyIcon()), 1200);
      }).catch(() => toast('Copy failed'));
    });
    return b;
  }
  function bubble(m) {
    const el = h('div', `ytx-msg ytx-msg-${m.role}`);
    if (m.ts) el.title = fmtClock(m.ts);
    if (m.role === 'assistant') {
      el.append(renderMd(m.content), copyBtn(m.content));
      if (m.usage) el.append(h('span', 'ytx-msg-usage', llm.fmtUsage(m.model, m.usage)));
    } else {
      if (m.image) { const img = h('img', 'ytx-msg-img'); img.src = m.image; img.alt = 'Captured frame'; el.append(img); }
      if (m.sec != null) el.append(h('span', 'ytx-msg-at', `@${fmtTime(m.sec)}`));
      el.append(h('div', 'ytx-msg-text', m.content));
    }
    return el;
  }

  let prompts = PROMPTS;
  db.getSettings().then((s) => { prompts = parsePrompts(s.prompts); renderPresets(); }).catch(() => {});
  function renderPresets() {
    presets.textContent = '';
    const c = cur();
    if ((c && c.messages.length) || !prompts.length) { presets.hidden = true; return; }
    presets.hidden = false;
    for (const p of prompts) {
      const b = h('button', 'ytx-chat-preset', p.label);
      b.type = 'button';
      b.title = p.text;
      b.addEventListener('click', () => send(p.text));
      presets.append(b);
    }
  }

  function refresh() {
    bar.refresh();
    const c = cur();
    list.textContent = '';
    if (!c || !c.messages.length) {
      const empty = h('div', 'ytx-chat-empty');
      empty.append(h('div', 'ytx-chat-empty-title', 'Ask anything about this video'),
        h('div', 'ytx-chat-empty-hint', 'Answers cite timestamps you can click. Pick a preset below or type your own.'));
      if (retrieval(modelId())) empty.append(h('div', 'ytx-chat-empty-warn', 'Long video: the transcript does not fit this model, so it will search the transcript instead. Slower, but nothing is cut off.'));
      list.append(empty);
    } else {
      for (const m of c.messages) list.append(bubble(m));
    }
    renderPresets();
    paintCtx();
    list.scrollTop = list.scrollHeight;
    newPill.classList.remove('is-on');
  }

  function errorBubble(e, retry) {
    const el = h('div', 'ytx-msg ytx-msg-system');
    if (e && e.message === 'no-api-key') {
      el.append('Add your API key in Settings. ');
      if (opts.settingsAction) el.append(opts.settingsAction());
    } else if (e && e.message === 'cancelled') {
      el.textContent = 'Stopped.';
    } else {
      el.append(h('span', null, (e && e.message) || 'Something went wrong'));
      if (retry) {
        const b = h('button', 'ytx-chat-retry', 'Retry');
        b.type = 'button';
        b.addEventListener('click', retry);
        el.append(b);
      }
    }
    list.append(el);
    scrollBottom(true);
  }

  // First reply in a "New chat" → ask the model for a short title (best effort, never blocks).
  function autoTitle(chat, settings) {
    if (chat.title !== db.NEW_CHAT_TITLE || chat.messages.length !== 2) return;
    llm.titleChat({ settings, messages: chat.messages }).then((t) => {
      if (!t || chat.title !== db.NEW_CHAT_TITLE) return;
      chat.title = t;
      chat.updatedAt = Date.now();
      save();
      if (live()) bar.refresh();
      sync(chat);
    }).catch((e) => console.warn('[ytx] title', e));
  }

  /* ---- send / stream / stop ---- */
  let busy = false;
  let gen = 0;
  let ctl = null; // AbortController of the in-flight request
  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? '■' : '↑';
    sendBtn.title = b ? 'Stop (Esc)' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
    sendBtn.classList.toggle('is-stop', b);
  }
  function cancel() {
    if (ctl) ctl.abort();
  }

  // Runs the model on chat.messages (the last one being the user's). Streams into a live bubble.
  async function run(chat) {
    if (busy) return;
    setBusy(true);
    const myGen = ++gen;
    ctl = new AbortController();
    const pending = h('div', 'ytx-msg ytx-msg-assistant ytx-msg-pending');
    const status = h('span', 'ytx-msg-status', 'Thinking…');
    const body = h('div', 'ytx-msg-stream');
    pending.append(status, body);
    list.append(pending);
    scrollBottom(true);
    const t0 = Date.now();
    let streamed = '';
    const tick = setInterval(() => {
      if (streamed) return;
      status.textContent = `Thinking… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);
    try {
      const settings = await db.getSettings();
      lastSettings = settings;
      if (settings.webSearch) status.textContent = 'Thinking… (web search on)';
      const id = llm.parseModel(settings.model).id;
      const reply = await llm.chat({
        settings,
        system: sysPrompt(id, settings),
        tools: retrieval(id) ? llm.transcriptTools(segments()) : null,
        onTool: (name, input) => {
          if (streamed) return;
          status.textContent = name === 'search_transcript' ? `Searching transcript: ${input.query ?? ''}` : `Reading transcript ${input.from ?? ''} to ${input.to ?? ''}`;
        },
        messages: chat.messages.map(({ role, content, image }) => ({ role, content, image })),
        signal: ctl.signal,
        onText: (delta) => {
          if (myGen !== gen || !live()) return;
          if (!streamed) status.remove();
          streamed += delta;
          body.textContent = streamed;
          scrollBottom();
        },
      });
      if (myGen !== gen || !live()) return;
      chat.messages.push({ role: 'assistant', content: reply.text, ts: Date.now(), usage: reply.usage, model: reply.model });
      chat.updatedAt = Date.now();
      await save();
      sync(chat);
      autoTitle(chat, settings);
      if (cur() === chat) refresh();
    } catch (e) {
      if (myGen !== gen || !live()) return;
      pending.remove();
      if (e.message === 'cancelled' && streamed.trim()) {
        // keep what came through, marked as partial
        chat.messages.push({ role: 'assistant', content: `${streamed}\n\n*[stopped]*`, ts: Date.now() });
        chat.updatedAt = Date.now();
        save();
        sync(chat);
        refresh();
      } else {
        errorBubble(e, () => run(chat));
      }
    } finally {
      clearInterval(tick);
      if (myGen === gen) {
        ctl = null;
        pending.remove(); // no-op if refresh already wiped the list
        if (live()) { setBusy(false); ta.focus(); }
      }
    }
  }

  async function send(text = ta.value) {
    text = String(text).trim();
    if (busy || (!text && !frame)) return;
    ta.value = '';
    autosize(ta);
    const chat = ensureChat();
    const m = { role: 'user', content: text || 'What is shown in this frame?', ts: Date.now() };
    if (frame) Object.assign(m, { image: frame.dataUrl, sec: frame.sec, ...(frame.embed ? { embed: frame.embed } : {}) });
    setFrame(null);
    chat.messages.push(m);
    chat.updatedAt = Date.now();
    await save().catch((e) => console.warn('[ytx] save failed', e)); // a failed write must not wedge busy
    if (!live()) return;
    refresh();
    run(chat);
  }

  sendBtn.addEventListener('click', () => (busy ? cancel() : send()));
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); return; }
    if (e.key === 'Escape' && busy) { e.preventDefault(); cancel(); return; }
    if (!e.altKey) e.stopPropagation(); // keep the host page's hotkeys out of the field
  });

  refresh();
  return {
    root,
    refresh,
    toggleWeb,
    cancel,
    focus: () => ta.focus(),
    prefill: (text) => { ta.value = text; autosize(ta); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; },
    isBusy: () => busy,
  };
}
