// MV2 event page — dumb HTTP proxy (host permissions → no CORS), native host bridge, library opener.
'use strict';

const ALLOWED_PREFIXES = ['https://api.anthropic.com/', 'https://api.openai.com/'];
const NATIVE_HOST = 'yt_transcriber';

async function proxyHttp({ url, method = 'GET', headers = {}, body }) {
  if (!ALLOWED_PREFIXES.some((p) => String(url).startsWith(p))) {
    return { ok: false, error: 'host not allowed' };
  }
  try {
    const h = { ...headers };
    let payload = body;
    if (body !== undefined && body !== null && typeof body === 'object') {
      payload = JSON.stringify(body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
        h['content-type'] = 'application/json';
      }
    }
    const res = await fetch(url, { method, headers: h, body: payload });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch (_) {
      /* raw text */
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message || `HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// One long-lived native port (a fresh node process per message would cost ~60ms each).
// Requests are correlated by id; a disconnect rejects everything in flight and drops the port.
let port = null;
let seq = 0;
const pending = new Map();

function getPort() {
  if (port) return port;
  port = browser.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener((msg) => {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    p(msg.ok ? { ...msg, ok: true } : { ok: false, error: msg.error || 'native host error' });
  });
  port.onDisconnect.addListener((p) => {
    const err = p.error?.message || browser.runtime.lastError?.message || 'native host disconnected';
    port = null;
    for (const resolve of pending.values()) resolve({ ok: false, error: err });
    pending.clear();
  });
  return port;
}

function native(msg) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    // A wedged host must not hang the UI forever; the folder dialog legitimately takes a while.
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve({ ok: false, error: 'native host timeout' });
    }, msg.op === 'pick-folder' ? 300000 : 20000);
    try {
      getPort().postMessage({ ...msg, type: undefined, id });
    } catch (e) {
      pending.delete(id);
      port = null;
      resolve({ ok: false, error: e.message });
    }
  });
}

// Streaming proxy: one port per request. Body is read as SSE; each `data:` JSON is forwarded as
// {type:'event'}; the port closing from the other side aborts the fetch.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'stream') return;
  const ctl = new AbortController();
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; ctl.abort(); });
  const post = (m) => { if (!closed) { try { port.postMessage(m); } catch { closed = true; } } };
  port.onMessage.addListener(async ({ url, method = 'POST', headers = {}, body }) => {
    if (!ALLOWED_PREFIXES.some((p) => String(url).startsWith(p))) return post({ type: 'error', error: 'host not allowed' });
    try {
      const h = { 'content-type': 'application/json', accept: 'text/event-stream', ...headers };
      const res = await fetch(url, { method, headers: h, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) {
        const text = await res.text();
        let data = text;
        try { data = JSON.parse(text); } catch (_) { /* raw */ }
        return post({ type: 'error', status: res.status, error: data?.error?.message || `HTTP ${res.status}` });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { post({ type: 'event', event: JSON.parse(payload) }); } catch (_) { /* keepalive / partial */ }
          }
        }
      }
      post({ type: 'done' });
    } catch (e) {
      post({ type: 'error', error: e.name === 'AbortError' ? 'cancelled' : e.message });
    }
  });
});

async function openLibrary() {
  try {
    await browser.tabs.create({ url: browser.runtime.getURL('page/app.html') });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'http') return proxyHttp(msg);
  if (msg && msg.type === 'native') return native(msg);
  if (msg && msg.type === 'open-library') return openLibrary();
});

browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL('page/app.html') });
});
