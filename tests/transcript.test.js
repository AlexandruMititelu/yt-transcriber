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
