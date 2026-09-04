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
    // cues: the raw caption lines inside the row, so Follow can highlight the exact one being spoken.
    if (!group) group = { start: seg.start, end: seg.start + seg.dur, text: seg.text, cues: [{ start: seg.start, text: seg.text }] };
    else {
      group.text += ' ' + seg.text;
      group.end = seg.start + seg.dur;
      group.cues.push({ start: seg.start, text: seg.text });
    }
  }
  if (group) groups.push(group);
  return groups;
}

// Chapters from the description: lines starting with (or containing) a timestamp followed by a title.
export function parseChapters(description) {
  const out = [];
  for (const raw of String(description || '').split('\n')) {
    const m = /^\s*(?:[-•*]\s*)?(?:\(|\[)?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\)|\])?\s*[-–—:|]?\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const start = m[1].split(':').reduce((a, p) => a * 60 + Number(p), 0);
    if (out.length && start <= out[out.length - 1].start) continue; // must be increasing
    out.push({ start, title: m[2].replace(/^[-–—:|]\s*/, '') });
  }
  return out.length >= 2 ? out : [];
}

// Human reason for a video with no usable transcript.
export function explainFailure(err) {
  const m = String(err?.message || '');
  if (m === 'no-captions') return 'No captions on this video';
  if (m === 'live') return 'Live streams have no transcript until the stream ends';
  if (m.startsWith('unplayable:')) return `YouTube blocks the transcript: ${m.slice(11).trim() || 'unavailable'}`;
  if (m === 'bad-response') return "Couldn't reach YouTube (offline? captive portal?)";
  return `Couldn't load transcript: ${m}`;
}

// { lang: preferred language prefix, track?: {lang, asr} exact pick, translate?: target language }
export async function fetchTranscript(videoId, { fetchFn = fetch, lang = 'en', track: want, translate } = {}) {
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
  let pr;
  try { pr = await res.json(); } catch { throw new Error('bad-response'); }
  const status = pr?.playabilityStatus;
  if (status && status.status && status.status !== 'OK' && !pr?.captions) {
    throw new Error(`unplayable: ${status.reason || status.status}`);
  }
  if (pr?.videoDetails?.isLive || pr?.videoDetails?.isLiveContent && !pr?.captions) throw new Error('live');
  const tracks = extractTracks(pr);
  const track = (want && tracks.find((t) => t.lang === want.lang && !!t.asr === !!want.asr)) || pickTrack(tracks, [lang, 'en']);
  if (!track) throw new Error('no-captions');
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  if (translate) u.searchParams.set('tlang', translate);
  let text;
  try { text = await (await fetchFn(u.toString())).text(); } catch { throw new Error('bad-response'); }
  if (!text) throw new Error('no-captions');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('bad-response'); }
  const d = pr?.videoDetails ?? {};
  return {
    lang: translate || track.lang,
    trackName: translate ? `${track.name} → ${translate}` : track.name,
    track: { lang: track.lang, asr: !!track.asr },
    translate: translate || null,
    tracks: tracks.map(({ lang: l, name, asr }) => ({ lang: l, name, asr: !!asr })),
    segments: parseJson3(json),
    title: d.title ?? '',
    channel: d.author ?? '',
    duration: Number(d.lengthSeconds) || 0,
    chapters: parseChapters(d.shortDescription),
  };
}
