// Runtime message helpers — talk to background.js.

export async function call(msg) {
  const r = await browser.runtime.sendMessage(msg);
  if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
  return r;
}

export async function http(url, opts = {}) {
  return call({ type: 'http', url, ...opts });
}

// Native messaging host (native/host.mjs): { op, ...args } → host reply. Throws when the host is
// not installed ("No such native application yt_transcriber").
export async function native(msg) {
  return call({ type: 'native', ...msg });
}
