import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlayerResponse,
  extractTracks,
  pickTrack,
  parseJson3,
  groupSegments,
  fetchTranscript,
  parseChapters,
  explainFailure,
  panelParams,
  parsePanel,
} from '../src/lib/transcript.js';
const transcript = { parseChapters, explainFailure };

const PR = {
  videoDetails: { title: 'brace } inside "quoted { string" \\ test' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          languageCode: 'fr',
          name: { simpleText: 'French' },
          baseUrl: 'https://yt/api/timedtext?lang=fr',
          vssId: '.fr',
        },
        {
          languageCode: 'en',
          name: { runs: [{ text: 'English (auto)' }] },
          baseUrl: 'https://yt/api/timedtext?lang=en',
          vssId: 'a.en',
          kind: 'asr',
        },
      ],
    },
  },
};

test('extractPlayerResponse handles braces inside strings', () => {
  const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(PR)};var meta = {a:1};</script></html>`;
  const pr = extractPlayerResponse(html);
  assert.deepEqual(pr, PR);
});

test('extractPlayerResponse without var prefix', () => {
  const html = `window.foo = 1; ytInitialPlayerResponse = {"a": "b } c", "d": {"e": 1}}; more`;
  assert.deepEqual(extractPlayerResponse(html), { a: 'b } c', d: { e: 1 } });
});

test('extractPlayerResponse absent → null', () => {
  assert.equal(extractPlayerResponse('<html>nothing here</html>'), null);
});

test('extractTracks maps fields', () => {
  const tracks = extractTracks(PR);
  assert.deepEqual(tracks, [
    { lang: 'fr', name: 'French', baseUrl: 'https://yt/api/timedtext?lang=fr', asr: false },
    { lang: 'en', name: 'English (auto)', baseUrl: 'https://yt/api/timedtext?lang=en', asr: true },
  ]);
  assert.deepEqual(extractTracks(null), []);
  assert.deepEqual(extractTracks({}), []);
});

test('pickTrack prefers manual matching lang, then asr, then any manual, then first', () => {
  const manualEn = { lang: 'en', asr: false };
  const asrEn = { lang: 'en', asr: true };
  const manualFr = { lang: 'fr', asr: false };
  const asrDe = { lang: 'de', asr: true };

  assert.equal(pickTrack([asrEn, manualFr, manualEn]), manualEn);
  assert.equal(pickTrack([manualFr, asrEn]), asrEn);
  assert.equal(pickTrack([asrDe, manualFr]), manualFr);
  assert.equal(pickTrack([asrDe]), asrDe);
  assert.equal(pickTrack([]), null);
  assert.equal(pickTrack([{ lang: 'en-US', asr: false }], ['en']).lang, 'en-US'); // prefix match
});

test('parseJson3 joins segs, collapses whitespace, drops empties', () => {
  const j = {
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hello\n' }, { utf8: ' world  ' }] },
      { tStartMs: 2500, dDurationMs: 1000 }, // no segs
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '\n' }] }, // empty text
      { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'bye' }] },
    ],
  };
  assert.deepEqual(parseJson3(j), [
    { start: 0, dur: 2, text: 'hello world' },
    { start: 4, dur: 1.5, text: 'bye' },
  ]);
});

test('groupSegments closes on window and computes end', () => {
  const segs = [
    { start: 0, dur: 5, text: 'a' },
    { start: 10, dur: 5, text: 'b' },
    { start: 20, dur: 5, text: 'c' },
  ];
  assert.deepEqual(groupSegments(segs, { window: 20, maxChars: 300 }), [
    { start: 0, end: 15, text: 'a b', cues: [{ start: 0, text: 'a' }, { start: 10, text: 'b' }] },
    { start: 20, end: 25, text: 'c', cues: [{ start: 20, text: 'c' }] },
  ]);
});

test('groupSegments closes on maxChars', () => {
  const segs = [
    { start: 0, dur: 1, text: 'x'.repeat(30) },
    { start: 1, dur: 1, text: 'y' },
    { start: 2, dur: 1, text: 'z' },
  ];
  const groups = groupSegments(segs, { window: 100, maxChars: 20 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, 'x'.repeat(30));
  assert.deepEqual(groups[1], { start: 1, end: 3, text: 'y z', cues: [{ start: 1, text: 'y' }, { start: 2, text: 'z' }] });
});

test('fetchTranscript with injected fetchFn', async () => {
  const json3 = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] };
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) return { json: async () => PR };
    return { text: async () => JSON.stringify(json3) };
  };
  const r = await fetchTranscript('abc123', { fetchFn });
  assert.equal(calls[0].url, 'https://www.youtube.com/youtubei/v1/player');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(JSON.parse(calls[0].opts.body).videoId, 'abc123');
  assert.equal(JSON.parse(calls[0].opts.body).context.client.clientName, 'ANDROID');
  assert.equal(calls[1].url, 'https://yt/api/timedtext?lang=en&fmt=json3');
  assert.equal(r.lang, 'en');
  assert.equal(r.trackName, 'English (auto)');
  assert.deepEqual(r.track, { lang: 'en', asr: true });
  assert.deepEqual(r.segments, [{ start: 0, dur: 1, text: 'hi' }]);
  assert.equal(r.title, 'brace } inside "quoted { string" \\ test'); // videoDetails.title from the player response
  assert.equal(r.channel, '');
  assert.ok(Array.isArray(r.tracks) && r.tracks.length >= 1);
  assert.deepEqual(r.chapters, []);
  // translation and explicit track go through the query string
  const r2 = await fetchTranscript('abc123', { fetchFn, translate: 'ro', track: { lang: 'en', asr: true } });
  assert.match(calls.at(-1).url, /tlang=ro/);
  assert.equal(r2.lang, 'ro');
});

test('fetchTranscript overrides existing fmt param', async () => {
  const pr = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: 'en', baseUrl: 'https://yt/api/timedtext?lang=en&fmt=srv3' },
  ] } } };
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.startsWith('https://www.youtube.com/youtubei')) return { json: async () => pr };
    return { text: async () => '{"events":[]}' };
  };
  await fetchTranscript('abc', { fetchFn });
  assert.equal(calls[1], 'https://yt/api/timedtext?lang=en&fmt=json3');
});

test('fetchTranscript throws no-captions', async () => {
  const fetchFn = async () => ({ json: async () => ({ playabilityStatus: { status: 'OK' } }) });
  await assert.rejects(fetchTranscript('abc', { fetchFn }), { message: 'no-captions' });
});

test('fetchTranscript throws no-captions on empty caption body', async () => {
  const fetchFn = async (url) =>
    url.startsWith('https://www.youtube.com/youtubei') ? { json: async () => PR } : { text: async () => '' };
  await assert.rejects(fetchTranscript('abc', { fetchFn }), { message: 'no-captions' });
});

// Trimmed youtubei/v1/get_panel response captured from a watch page (Oct 2026).
const PANEL = {
  content: { engagementPanelSectionListRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { macroMarkersPanelItemViewModel: { index: 0, item: { timelineItemViewModel: { timestamp: '0:01', contentItems: [{ transcriptSegmentViewModel: { simpleText: '[♪♪♪]' } }] } } } },
    { macroMarkersPanelItemViewModel: { index: 1, item: { timelineItemViewModel: { timestamp: '0:18', contentItems: [{ transcriptSegmentViewModel: { simpleText: "♪ We're no strangers to love ♪" } }, { transcriptSegmentViewModel: { simpleText: '♪ You know the rules ♪' } }] } } } },
    { macroMarkersPanelItemViewModel: { index: 2, item: { timelineItemViewModel: { timestamp: '1:27', contentItems: [{ transcriptSegmentViewModel: { simpleText: 'no sync entry' } }] } } } },
  ] } }] } } } },
  frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { timedMarkersListSyncEntity: { timedListData: { sections: [{ timedSyncDataList: [
    { videoTimeMs: '1000', syncItemId: 'timeline_view_sync_item0_0', endTimeMs: '3040' },
    { videoTimeMs: '18000', syncItemId: 'timeline_view_sync_item0_1', endTimeMs: '26960' },
  ] }] } } } }] } },
};

test('panelParams matches the params the watch page sends', () => {
  assert.equal(panelParams('dQw4w9WgXcQ'), 'qgkPCgtkUXc0dzlXZ1hjURgC');
});

test('parsePanel: rows with ms timing from the sync entity, m:ss fallback', () => {
  assert.deepEqual(parsePanel(PANEL), [
    { start: 1, dur: 2.04, text: '[♪♪♪]' },
    { start: 18, dur: 8.96, text: "♪ We're no strangers to love ♪ ♪ You know the rules ♪" },
    { start: 87, dur: 0, text: 'no sync entry' },
  ]);
  assert.deepEqual(parsePanel({}), []);
});

test('fetchTranscript falls back to the transcript panel when the phone client is bot-checked', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, client: body?.context?.client?.clientName, credentials: opts?.credentials });
    if (body?.context?.client?.clientName === 'ANDROID') return { json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } }) };
    if (url.endsWith('/get_panel')) { assert.equal(body.panelId, 'PAmodern_transcript_view'); assert.equal(body.params, panelParams('abc')); return { json: async () => PANEL }; }
    return { json: async () => ({ videoDetails: { title: 'T', author: 'A', lengthSeconds: '213' } }) };
  };
  const r = await fetchTranscript('abc', { fetchFn });
  assert.equal(calls[0].credentials, 'omit'); // phone client: no web cookies
  assert.deepEqual(calls.slice(1).map((c) => [c.url.split('/').pop(), c.client, c.credentials]).sort(), [['get_panel', 'WEB', 'include'], ['player', 'WEB', 'include']]);
  assert.equal(r.segments.length, 3);
  assert.equal(r.title, 'T');
  assert.equal(r.duration, 213);
  assert.deepEqual(r.tracks, []);
  assert.equal(r.translate, null);
  // the panel cannot translate: a translate request surfaces the original block instead
  await assert.rejects(fetchTranscript('abc', { fetchFn, translate: 'ro' }), /unplayable: Sign in/);
  // the panel failing too surfaces the original reason, not the panel's
  const blocked = async (url, opts) => (url.endsWith('/get_panel') ? { json: async () => ({}) } : fetchFn(url, opts));
  await assert.rejects(fetchTranscript('abc', { fetchFn: blocked }), /unplayable: Sign in/);
});

test('parseChapters reads description timestamps (needs two or more, increasing)', () => {
  const ch = transcript.parseChapters('Intro\n0:00 Welcome\n1:30 - Setup\n(12:05) Demo time\n1:00:00 Outro\nthanks');
  assert.deepEqual(ch, [
    { start: 0, title: 'Welcome' }, { start: 90, title: 'Setup' }, { start: 725, title: 'Demo time' }, { start: 3600, title: 'Outro' },
  ]);
  assert.deepEqual(transcript.parseChapters('0:00 only one'), []);
});

test('explainFailure maps error codes to readable reasons', () => {
  assert.equal(transcript.explainFailure(new Error('no-captions')), 'No captions on this video');
  assert.match(transcript.explainFailure(new Error('unplayable: Sign in to confirm your age')), /age/);
  assert.match(transcript.explainFailure(new Error('live')), /Live/);
});

test('transcriptAt: cue at the time, neighbours across rows, whole block', async () => {
  const { transcriptAt } = await import('../src/lib/transcript.js');
  const grouped = [
    { start: 0, end: 20, text: 'a b', cues: [{ start: 0, text: 'a' }, { start: 10, text: 'b' }] },
    { start: 20, end: 40, text: 'c d', cues: [{ start: 20, text: 'c' }, { start: 30, text: 'd' }] },
  ];
  assert.deepEqual(transcriptAt(grouped, 12), { start: 10, line: 'b', prev: 'a', next: 'c', block: 'a b', blockStart: 0 });
  assert.deepEqual(transcriptAt(grouped, 99).line, 'd');
  assert.equal(transcriptAt(grouped, 0).prev, '');
  assert.equal(transcriptAt([{ start: 0, end: 5, text: 'old' }], 3).line, 'old', 'rows without cues');
  assert.equal(transcriptAt([], 3), null);
});
