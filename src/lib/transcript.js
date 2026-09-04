// YouTube transcript extraction pipeline.

export function extractPlayerResponse(html) {
  const m = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function extractTracks(pr) {
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return tracks.map((t) => ({
    lang: t.languageCode,
    name: t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? t.languageCode,
    baseUrl: t.baseUrl,
    asr: t.vssId?.startsWith('a.') || t.kind === 'asr',
  }));
}

export function pickTrack(tracks, prefLangs = ['en']) {
  if (!tracks.length) return null;
  const match = (t, pref) => t.lang?.startsWith(pref);
  for (const pref of prefLangs) {
    const manual = tracks.find((t) => !t.asr && match(t, pref));
    if (manual) return manual;
  }
  for (const pref of prefLangs) {
    const asr = tracks.find((t) => t.asr && match(t, pref));
    if (asr) return asr;
  }
  return tracks.find((t) => !t.asr) ?? tracks[0];
}

export function parseJson3(j) {
  const out = [];
  for (const ev of j?.events ?? []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ start: ev.tStartMs / 1000, dur: (ev.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

export function groupSegments(segs, { window = 20, maxChars = 300 } = {}) {
  const groups = [];
  let group = null;
  for (const seg of segs) {
    if (group && (seg.start - group.start >= window || group.text.length > maxChars)) {
      groups.push(group);
      group = null;
    }
    if (!group) group = { start: seg.start, end: seg.start + seg.dur, text: seg.text };
    else {
      group.text += ' ' + seg.text;
      group.end = seg.start + seg.dur;
    }
  }
  if (group) groups.push(group);
  return groups;
}

export async function fetchTranscript(videoId, { fetchFn = fetch } = {}) {
  // Caption baseUrls from the watch-page player response return an empty body since 2025
  // (need a PO token). The InnerTube player endpoint with the ANDROID client still hands out
  // URLs that work without one.
  const res = await fetchFn('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 } },
      videoId,
    }),
  });
  const pr = await res.json();
  const track = pickTrack(extractTracks(pr));
  if (!track) throw new Error('no-captions');
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  const text = await (await fetchFn(u.toString())).text();
  if (!text) throw new Error('no-captions');
  return {
    lang: track.lang,
    trackName: track.name,
    segments: parseJson3(JSON.parse(text)),
    title: pr?.videoDetails?.title ?? '',
    channel: pr?.videoDetails?.author ?? '',
  };
}
