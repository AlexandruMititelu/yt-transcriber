// Runtime message helpers — talk to background.js.

export async function call(msg) {
  const r = await browser.runtime.sendMessage(msg);
  if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
  return r;
}

// → { ok, status?, data?, error? } — never throws, so callers can branch on status (retry on 429).
export async function http(url, opts = {}) {
  const r = await browser.runtime.sendMessage({ type: 'http', url, ...opts });
  return r || { ok: false, error: 'no response' };
}

// Native messaging host (native/host.mjs): { op, ...args } → host reply. Throws when the host is
// not installed ("No such native application yt_transcriber").
export async function native(msg) {
  return call({ type: 'native', ...msg });
}

// Streaming HTTP through a background port: every SSE `data:` JSON object is handed to onEvent as it
// arrives. Resolves { ok } / { ok: false, status, error }; aborting the signal disconnects the port
// (background aborts the fetch). Falls back to a plain http() when ports are unavailable (tests).
export function stream(url, opts, { onEvent, signal } = {}) {
  if (!browser.runtime.connect) return http(url, opts).then((r) => {
    if (r.ok && onEvent) for (const ev of r.data?.events ?? []) onEvent(ev);
    return r;
  });
  return new Promise((resolve) => {
    const port = browser.runtime.connect({ name: 'stream' });
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); try { port.disconnect(); } catch { /* gone */ } };
    port.onMessage.addListener((m) => {
      if (m.type === 'event') { try { onEvent && onEvent(m.event); } catch (e) { console.warn('[ytx] stream event', e); } }
      else if (m.type === 'done') finish({ ok: true });
      else if (m.type === 'error') finish({ ok: false, status: m.status, error: m.error });
    });
    port.onDisconnect.addListener(() => finish({ ok: false, error: signal?.aborted ? 'cancelled' : 'stream disconnected' }));
    if (signal) signal.addEventListener('abort', () => finish({ ok: false, error: 'cancelled' }), { once: true });
    port.postMessage({ url, ...opts });
  });
}
