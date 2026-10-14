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

// What is being said at `sec`, from grouped rows (with cues): the cue line, its neighbours, the whole row.
// → { start, line, prev, next, block, blockStart } | null
export function transcriptAt(grouped, sec) {
  if (!grouped?.length) return null;
  let gi = grouped.findIndex((g) => g.start > sec) - 1;
  if (gi < -1) gi = grouped.length - 1;
  if (gi < 0) gi = 0;
  const cues = grouped.flatMap((g, i) => (g.cues?.length ? g.cues : [{ start: g.start, text: g.text }]).map((c) => ({ ...c, gi: i })));
  let ci = cues.findIndex((c) => c.start > sec) - 1;
  if (ci < -1) ci = cues.length - 1;
  if (ci < 0) ci = 0;
  const g = grouped[gi];
  return { start: cues[ci].start, line: cues[ci].text, prev: cues[ci - 1]?.text ?? '', next: cues[ci + 1]?.text ?? '', block: g.text, blockStart: g.start };
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

const YTI = 'https://www.youtube.com/youtubei/v1/';
const ANDROID = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 };
const WEB = { clientName: 'WEB', clientVersion: '2.20261013.00.00' };
const post = (fetchFn, endpoint, body, credentials) =>
  fetchFn(YTI + endpoint, { method: 'POST', credentials, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// `params` of the page's own transcript-panel request (youtubei/v1/get_panel): protobuf field 149 wrapping
// { 1: videoId, 3: 2 }, base64. Captured from the watch page in Oct 2026.
export function panelParams(videoId) {
  const inner = `\x0a${String.fromCharCode(videoId.length)}${videoId}\x18\x02`;
  return btoa(`\xaa\x09${String.fromCharCode(inner.length)}${inner}`);
}

// get_panel response → segments. Rows are what the panel shows (a few caption lines each); ms timing comes
// from the sync entity, keyed by row index; the "m:ss" label is the fallback.
export function parsePanel(j) {
  const items = j?.content?.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.itemSectionRenderer?.contents ?? [];
  const sync = new Map();
  for (const m of j?.frameworkUpdates?.entityBatchUpdate?.mutations ?? []) {
    for (const sec of m.payload?.timedMarkersListSyncEntity?.timedListData?.sections ?? []) {
      for (const t of sec.timedSyncDataList ?? []) sync.set(Number(/(\d+)$/.exec(t.syncItemId ?? '')?.[1]), t);
    }
  }
  const out = [];
  for (const it of items) {
    const vm = it.macroMarkersPanelItemViewModel;
    const tl = vm?.item?.timelineItemViewModel;
    if (!tl) continue;
    const text = (tl.contentItems ?? []).map((c) => c.transcriptSegmentViewModel?.simpleText ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t = sync.get(Number(vm.index ?? 0));
    const start = t ? Number(t.videoTimeMs) / 1000 : String(tl.timestamp ?? '0').split(':').reduce((a, p) => a * 60 + Number(p), 0);
    const dur = t ? Math.max(0, Number(t.endTimeMs) - Number(t.videoTimeMs)) / 1000 : 0;
    out.push({ start, dur, text });
  }
  return out;
}

const meta = (pr) => {
  const d = pr?.videoDetails ?? {};
  return { title: d.title ?? '', channel: d.author ?? '', duration: Number(d.lengthSeconds) || 0, chapters: parseChapters(d.shortDescription) };
};

// Primary path: InnerTube player with the ANDROID client (caption URLs work without a PO token; the web ones
// return an empty body since 2025). Cookies omitted: a phone client never carries web cookies, and the
// mismatch is one bot-check trigger.
async function viaPlayer(videoId, fetchFn, { lang, want, translate }) {
  const res = await post(fetchFn, 'player', { context: { client: ANDROID }, videoId }, 'omit');
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
  try { text = await (await fetchFn(u.toString(), { credentials: 'omit' })).text(); } catch { throw new Error('bad-response'); }
  if (!text) throw new Error('no-captions');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('bad-response'); }
  return {
    ...meta(pr),
    lang: translate || track.lang,
    trackName: translate ? `${track.name} → ${translate}` : track.name,
    track: { lang: track.lang, asr: !!track.asr },
    translate: translate || null,
    tracks: tracks.map(({ lang: l, name, asr }) => ({ lang: l, name, asr: !!asr })),
    segments: parseJson3(json),
  };
}

// Fallback when YouTube bot-checks the phone client ("Sign in to confirm you're not a bot"): the request the
// watch page itself makes for its transcript panel, WEB client with the browser's cookies. Same shape as the
// primary minus what the panel does not offer: track picker, translation, caption-line granularity.
async function viaPanel(videoId, fetchFn) {
  const [panel, pr] = await Promise.all([
    post(fetchFn, 'get_panel', { context: { client: WEB }, panelId: 'PAmodern_transcript_view', params: panelParams(videoId) }, 'include')
      .then((r) => r.json()).catch(() => { throw new Error('bad-response'); }),
    post(fetchFn, 'player', { context: { client: WEB }, videoId }, 'include').then((r) => r.json()).catch(() => null), // metadata only
  ]);
  const segments = parsePanel(panel);
  if (!segments.length) throw new Error('no-captions');
  return { ...meta(pr), lang: null, trackName: 'Transcript panel', track: null, translate: null, tracks: [], segments };
}

// { lang: preferred language prefix, track?: {lang, asr} exact pick, translate?: target language }
export async function fetchTranscript(videoId, { fetchFn = fetch, lang = 'en', track: want, translate } = {}) {
  try {
    return await viaPlayer(videoId, fetchFn, { lang, want, translate });
  } catch (e) {
    // 'no-captions' from a playable response is authoritative; a block or an empty/garbled body is not.
    if (e.message === 'no-captions' || e.message === 'live' || translate) throw e;
    try { return await viaPanel(videoId, fetchFn); } catch { throw e; }
  }
}
