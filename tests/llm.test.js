import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.browser = { runtime: { sendMessage: async () => ({ ok: false, error: 'unmocked' }) } };

const llm = await import('../src/lib/llm.js');

test('buildRequest anthropic shape', () => {
  const r = llm.buildRequest({
    provider: 'anthropic',
    apiKey: 'sk-a',
    model: 'claude-x',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 99,
  });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-a');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.body.model, 'claude-x');
  assert.equal(r.body.max_tokens, 99);
  assert.deepEqual(r.body.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]); // cached system block
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('buildRequest openai shape: bearer, system as first message, no token param', () => {
  const r = llm.buildRequest({
    provider: 'openai',
    apiKey: 'sk-o',
    model: 'gpt-x',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer sk-o');
  assert.deepEqual(r.body.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(r.body.messages[1], { role: 'user', content: 'hi' });
  assert.ok(!('max_tokens' in r.body));
  assert.ok(!('max_completion_tokens' in r.body));
});

test('buildRequest falls back to DEFAULT_MODELS when model falsy', () => {
  const a = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: '', system: '', messages: [] });
  assert.equal(a.body.model, llm.DEFAULT_MODELS.anthropic);
  const o = llm.buildRequest({ provider: 'openai', apiKey: 'k', system: '', messages: [] });
  assert.equal(o.body.model, llm.DEFAULT_MODELS.openai);
});

test('buildRequest unknown provider throws', () => {
  assert.throws(() => llm.buildRequest({ provider: 'gemini', apiKey: 'k', system: '', messages: [] }));
});

test('parseResponse anthropic joins text blocks', () => {
  const json = {
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'tool_use', id: 'x' },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(llm.parseResponse('anthropic', json), 'Hello world');
});

test('parseResponse openai reads first choice, empty fallback', () => {
  assert.equal(llm.parseResponse('openai', { choices: [{ message: { content: 'hey' } }] }), 'hey');
  assert.equal(llm.parseResponse('openai', {}), '');
});

test('buildSystemPrompt contains title, channel, timestamps', () => {
  const p = llm.buildSystemPrompt({
    title: 'My Video',
    channel: 'My Channel',
    segments: [
      { start: 0, end: 5, text: 'intro words' },
      { start: 65, end: 80, text: 'main point' },
    ],
  });
  assert.ok(p.includes('My Video'));
  assert.ok(p.includes('My Channel'));
  assert.ok(p.includes('[0:00] intro words'));
  assert.ok(p.includes('[1:05] main point'));
  assert.ok(p.includes('mermaid'));
  assert.ok(!p.includes('[transcript truncated]'));
});

test('buildSystemPrompt hard-caps long transcripts with marker', () => {
  const segments = Array.from({ length: 2000 }, (_, i) => ({
    start: i * 20,
    end: i * 20 + 20,
    text: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(2),
  }));
  const p = llm.buildSystemPrompt({ title: 'T', channel: 'C', segments, cap: 24000 });
  assert.ok(p.length <= 24100, `prompt length ${p.length} exceeds 24100`);
  assert.ok(p.endsWith('[transcript truncated]'));
  assert.ok(p.includes('T'));
});

test('chat throws no-api-key when the selected provider has no key', async () => {
  await assert.rejects(
    llm.chat({ settings: { anthropicKey: '', openaiKey: 'sk-o', model: 'anthropic:claude-x' }, system: 's', messages: [] }),
    { message: 'no-api-key' },
  );
});

test('chat POSTs via bus and parses the response', async () => {
  const sent = [];
  globalThis.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    return { ok: true, status: 200, data: { content: [{ type: 'text', text: 'answer' }] } };
  };
  const out = await llm.chat({
    settings: { anthropicKey: 'sk', model: 'anthropic:', effort: 'off' },
    system: 'sys',
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(out.text, 'answer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'http');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].body.model, llm.DEFAULT_MODELS.anthropic);
});

test('chat surfaces bus errors', async () => {
  globalThis.browser.runtime.sendMessage = async () => ({ ok: false, error: 'HTTP 401' });
  await assert.rejects(
    llm.chat({ settings: { openaiKey: 'bad', model: 'openai:gpt-x' }, system: 's', messages: [] }),
    { message: 'HTTP 401' },
  );
});

test('buildRequest effort: anthropic thinking budget, openai reasoning_effort, off omits both', () => {
  const a = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'm', system: '', messages: [], effort: 'medium' });
  assert.equal(a.body.thinking.type, 'enabled');
  assert.ok(a.body.max_tokens > a.body.thinking.budget_tokens);
  const o = llm.buildRequest({ provider: 'openai', apiKey: 'k', model: 'm', system: '', messages: [], effort: 'high' });
  assert.equal(o.body.reasoning_effort, 'high');
  const off = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'm', system: '', messages: [], effort: 'off' });
  assert.ok(!('thinking' in off.body));
  const off2 = llm.buildRequest({ provider: 'openai', apiKey: 'k', model: 'm', system: '', messages: [] });
  assert.ok(!('reasoning_effort' in off2.body));
});

test('buildSystemPrompt includes aboutMe and tone before the transcript', () => {
  const p = llm.buildSystemPrompt({ title: 'T', channel: 'C', segments: [{ start: 0, text: 'x' }], aboutMe: 'I am Alex', tone: 'terse' });
  assert.ok(p.indexOf('About the user:\nI am Alex') < p.indexOf('Transcript:'));
  assert.ok(p.indexOf('Tone of voice:\nterse') < p.indexOf('Transcript:'));
  const q = llm.buildSystemPrompt({ title: 'T', channel: 'C', segments: [] });
  assert.ok(!q.includes('About the user') && !q.includes('Tone of voice'));
});

test('parseModel / keyFor / availableProviders / resolveModel', () => {
  assert.deepEqual(llm.parseModel('openai:gpt-5.1'), { provider: 'openai', id: 'gpt-5.1' });
  assert.deepEqual(llm.parseModel('anthropic:claude-sonnet-5'), { provider: 'anthropic', id: 'claude-sonnet-5' });
  const s = { anthropicKey: '', openaiKey: 'k', model: 'anthropic:claude-sonnet-5' };
  assert.deepEqual(llm.availableProviders(s), ['openai']);
  assert.equal(llm.keyFor(s, 'openai'), 'k');
  assert.equal(llm.resolveModel(s, { openai: ['gpt-5.1'] }), `openai:${llm.DEFAULT_MODELS.openai}`);
  assert.equal(llm.resolveModel({ model: 'openai:gpt-5' }, { openai: ['gpt-5.1'], anthropic: [] }), 'openai:gpt-5');
  assert.equal(llm.resolveModel(s, {}), s.model);
});

test('filterModelIds keeps chat families, drops audio/embeddings/dated snapshots', () => {
  const ids = ['gpt-5.1', 'gpt-5-mini', 'gpt-4o-audio-preview', 'text-embedding-3-small', 'gpt-5-2025-08-07', 'o3', 'tts-1', 'gpt-5.1', 'whisper-1'];
  assert.deepEqual(llm.filterModelIds('openai', ids), ['gpt-5-mini', 'gpt-5.1', 'o3']);
  assert.deepEqual(llm.filterModelIds('anthropic', ['b', 'a', 'a']), ['a', 'b']);
});

test('listModels GETs /v1/models and returns filtered ids', async () => {
  const sent = [];
  globalThis.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    return { ok: true, data: { data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }] } };
  };
  const ids = await llm.listModels({ provider: 'anthropic', apiKey: 'k' });
  assert.equal(sent[0].method, 'GET');
  assert.ok(sent[0].url.startsWith('https://api.anthropic.com/v1/models'));
  assert.equal(sent[0].headers['x-api-key'], 'k');
  assert.deepEqual(ids, ['claude-opus-5', 'claude-sonnet-5']);
});

test('buildRequest anthropic 4.6+/5: adaptive thinking + output_config.effort, never budget_tokens; off = disabled (omitted on Fable)', () => {
  const on = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', system: '', messages: [], effort: 'high' });
  assert.deepEqual(on.body.thinking, { type: 'adaptive' });
  assert.deepEqual(on.body.output_config, { effort: 'high' });
  assert.ok(!('budget_tokens' in on.body.thinking));
  assert.ok(on.body.max_tokens >= 16000);
  const off = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5', system: '', messages: [], effort: 'off' });
  assert.deepEqual(off.body.thinking, { type: 'disabled' });
  assert.ok(!('output_config' in off.body));
  const fable = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-fable-5-1', system: '', messages: [], effort: 'off' });
  assert.ok(!('thinking' in fable.body));
  const legacy = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5-20251001', system: '', messages: [], effort: 'low' });
  assert.equal(legacy.body.thinking.type, 'enabled');
  assert.equal(legacy.body.thinking.budget_tokens, 4000);
});

test('contextCap: by model family, unknown/empty falls back to PROMPT_CAP', () => {
  assert.equal(llm.contextWindow('claude-sonnet-5'), 1e6);
  assert.equal(llm.contextWindow('claude-haiku-4-5'), 200000);
  assert.equal(llm.contextWindow('gpt-5.1'), 400000);
  assert.equal(llm.contextWindow('gpt-4.1-mini'), 1e6);
  assert.equal(llm.contextWindow(''), 128000);
  assert.equal(llm.contextCap('claude-sonnet-5'), 700000);
  assert.equal(llm.PROMPT_CAP, 89600);
});

test('buildSystemPrompt honours cap', () => {
  const segments = [{ start: 0, text: 'x'.repeat(500) }];
  const p = llm.buildSystemPrompt({ title: 'T', channel: 'C', segments, cap: 100 });
  assert.ok(p.length <= 100 + '\n[transcript truncated]'.length);
  assert.ok(p.includes('[transcript truncated]'));
});

test('promptCoverage honours cap', () => {
  const segments = [{ start: 0, text: 'x'.repeat(500) }];
  assert.ok(llm.promptCoverage(segments, 100) < 1);
});

test('buildSystemPrompt forbids em dashes', () => {
  assert.ok(llm.buildSystemPrompt({ title: 't', channel: 'c', segments: [] }).includes('Never use em dashes'));
});

test('supportsEffort: thinking-capable families only; chat forces effort off otherwise', async () => {
  assert.equal(llm.supportsEffort('anthropic', 'claude-sonnet-5'), true);
  assert.equal(llm.supportsEffort('anthropic', 'claude-haiku-4-5-20251001'), true);
  assert.equal(llm.supportsEffort('anthropic', 'claude-3-5-haiku-20241022'), false);
  assert.equal(llm.supportsEffort('openai', 'gpt-5.1'), true);
  assert.equal(llm.supportsEffort('openai', 'o3'), true);
  assert.equal(llm.supportsEffort('openai', 'gpt-4o'), false);
  const sent = [];
  globalThis.browser.runtime.sendMessage = async (msg) => { sent.push(msg); return { ok: true, data: { choices: [] } }; };
  await llm.chat({ settings: { openaiKey: 'k', model: 'openai:gpt-4o', effort: 'high' }, system: 's', messages: [] });
  assert.ok(!('reasoning_effort' in sent[0].body));
  await llm.chat({ settings: { openaiKey: 'k', model: 'openai:gpt-5.1', effort: 'high' }, system: 's', messages: [] });
  assert.equal(sent[1].body.reasoning_effort, 'high');
});

test('web search: anthropic tool (variant by model) / openai web_search_options; off omits both', () => {
  const a = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', system: '', messages: [], webSearch: true });
  assert.deepEqual(a.body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
  const old = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5-20251001', system: '', messages: [], webSearch: true });
  assert.equal(old.body.tools[0].type, 'web_search_20250305');
  const o = llm.buildRequest({ provider: 'openai', apiKey: 'k', model: 'gpt-5.1', system: '', messages: [], webSearch: true });
  assert.deepEqual(o.body.web_search_options, {});
  const off = llm.buildRequest({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', system: '', messages: [] });
  assert.ok(!('tools' in off.body));
  assert.ok(llm.buildSystemPrompt({ title: 't', channel: 'c', segments: [], webSearch: true }).includes('search the web'));
  assert.ok(!llm.buildSystemPrompt({ title: 't', channel: 'c', segments: [] }).includes('search the web'));
});

test('parseResponse appends unique cited sources; anthropic citations and openai annotations', () => {
  const a = llm.parseResponse('anthropic', { content: [
    { type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'q' } },
    { type: 'web_search_tool_result', tool_use_id: 's', content: [] },
    { type: 'text', text: 'Alpha ', citations: [{ type: 'web_search_result_location', url: 'https://a.io', title: 'A' }] },
    { type: 'text', text: 'beta.', citations: [{ type: 'web_search_result_location', url: 'https://a.io', title: 'A' }, { url: 'https://b.io', title: 'B' }] },
  ] });
  assert.equal(a, 'Alpha beta.\n\nSources:\n- [A](https://a.io)\n- [B](https://b.io)');
  const o = llm.parseResponse('openai', { choices: [{ message: { content: 'x', annotations: [{ type: 'url_citation', url_citation: { url: 'https://c.io', title: 'C' } }] } }] });
  assert.equal(o, 'x\n\nSources:\n- [C](https://c.io)');
  assert.equal(llm.parseResponse('anthropic', { content: [{ type: 'text', text: 'plain' }] }), 'plain');
});

test('chat resumes pause_turn by re-sending the partial assistant turn, bounded', async () => {
  const sent = [];
  let n = 0;
  globalThis.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    n++;
    if (n === 1) return { ok: true, data: { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'q' } }] } };
    return { ok: true, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
  };
  const out = await llm.chat({ settings: { anthropicKey: 'k', model: 'anthropic:claude-sonnet-5', effort: 'off', webSearch: true }, system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.text, 'done');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.messages.length, 2);
  assert.equal(sent[1].body.messages[1].role, 'assistant');
  assert.equal(sent[1].body.messages[1].content[0].type, 'server_tool_use');
});

test('assembleAnthropic rebuilds the non-streaming shape (text, citations, usage, stop_reason)', () => {
  const got = [];
  const json = llm.assembleAnthropic([
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 80 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://a.io', title: 'A' } } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 7 } },
  ], (t) => got.push(t));
  assert.equal(got.join(''), 'Hello');
  const r = llm.parseResult('anthropic', json);
  assert.equal(r.text, 'Hello\n\nSources:\n- [A](https://a.io)\n\n*[Reply cut off: hit the length limit]*');
  assert.deepEqual(r.usage, { in: 180, out: 7, cacheRead: 80, cacheWrite: 0, searches: 0 }); // in = uncached + cached
  assert.equal(r.truncated, true);
  const o = llm.parseResult('openai', llm.assembleOpenai([
    { choices: [{ delta: { content: 'a' } }] }, { choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]));
  assert.equal(o.text, 'ab');
  assert.deepEqual(o.usage, { in: 5, out: 2, cacheRead: 0, cacheWrite: 0, searches: 0 });
});

test('fmtUsage shows tokens, and a $ estimate only for priced models', () => {
  assert.equal(llm.fmtK(1e6), '1M'); assert.equal(llm.fmtK(400000), '400k');
  assert.equal(llm.fmtUsage('claude-sonnet-4-6', { in: 12000, out: 300, cacheRead: 0 }), '12k in · 300 out · $0.041');
  assert.equal(llm.fmtUsage('gpt-4o', { in: 1200, out: 30 }), '1.2k in · 30 out');
});

test('chat retries once on 429 then succeeds', async () => {
  let n = 0;
  globalThis.browser.runtime.sendMessage = async () => (++n === 1 ? { ok: false, status: 429, error: 'rate' } : { ok: true, data: { content: [{ type: 'text', text: 'ok' }] } });
  const r = await llm.chat({ settings: { anthropicKey: 'k', model: 'anthropic:claude-x' }, system: 's', messages: [] });
  assert.equal(r.text, 'ok');
  assert.equal(n, 2);
});

test('transcriptTools: search ranks by rare words, read is bounded to 10 min and parses h:mm:ss', () => {
  const segs = Array.from({ length: 200 }, (_, i) => ({ start: i * 20, end: i * 20 + 20, text: `filler words about the video number ${i}` }));
  segs[150].text = 'gradient checkpointing saves memory during training';
  segs[151].text = 'checkpointing again';
  const t = llm.transcriptTools(segs);
  assert.deepEqual(t.defs.map((d) => d.name), ['search_transcript', 'read_transcript']);
  const hits = t.run('search_transcript', { query: 'memory checkpointing' });
  assert.ok(hits.startsWith('[50:00] gradient checkpointing'), hits);
  assert.ok(hits.includes('[50:20]'));
  assert.equal(t.run('search_transcript', { query: 'zzz' }), 'No matches. Try other words.');
  const read = t.run('read_transcript', { from: '0:10:00', to: '1:00:00' }).split('\n');
  assert.equal(read[0], '[10:00] filler words about the video number 30');
  assert.equal(read.length, 30); // capped at 600s
  assert.equal(t.run('read_transcript', { from: 99999, to: 99999 }), 'Nothing in that range.');
  assert.equal(llm.parseTime('1:02:03'), 3723);
});

test('buildSystemPrompt retrieval mode: no transcript, chapters + duration + tool instructions', () => {
  const p = llm.buildSystemPrompt({ title: 'T', channel: 'C', segments: [{ start: 0, end: 5, text: 'SECRET' }], retrieval: true, duration: 7200, chapters: [{ start: 60, title: 'Intro' }] });
  assert.ok(!p.includes('SECRET'));
  assert.ok(p.includes('2:00:00') && p.includes('[1:00] Intro') && p.includes('search_transcript'));
});

test('toApiMessages: data: URL images become provider blocks, plain messages untouched', () => {
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'what', image: 'data:image/jpeg;base64,AAAA' }];
  const a = llm.toApiMessages('anthropic', msgs);
  assert.deepEqual(a[0], { role: 'user', content: 'hi' });
  assert.deepEqual(a[1].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.equal(a[1].content[1].text, 'what');
  assert.equal(llm.toApiMessages('openai', msgs)[1].content[0].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('chat runs transcript tools: Anthropic tool_use round trip, usage summed', async () => {
  const sent = [];
  let n = 0;
  globalThis.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    n++;
    if (n === 1) return { ok: true, data: { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id: 't1', name: 'search_transcript', input: { query: 'cats' } }] } };
    return { ok: true, data: { stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 2 }, content: [{ type: 'text', text: 'Cats at 0:00.' }] } };
  };
  const tools = { defs: [{ name: 'search_transcript', description: 'd', input_schema: {} }], run: (name, input) => `${name}:${input.query}` };
  const calls = [];
  const out = await llm.chat({ settings: { anthropicKey: 'k', model: 'anthropic:claude-sonnet-5', effort: 'off' }, system: 's', messages: [{ role: 'user', content: 'cats?' }], tools, onTool: (n, i) => calls.push([n, i.query]) });
  assert.equal(out.text, 'Searching.\n\nCats at 0:00.');
  assert.deepEqual(out.usage, { in: 30, out: 3, cacheRead: 0, cacheWrite: 0, searches: 0, cost: 0.000135 });
  assert.deepEqual(calls, [['search_transcript', 'cats']]);
  assert.equal(sent[0].body.tools[0].name, 'search_transcript');
  const m = sent[1].body.messages;
  assert.equal(m.length, 3);
  assert.deepEqual(m[2].content, [{ type: 'tool_result', tool_use_id: 't1', content: 'search_transcript:cats' }]);
});

test('chat runs transcript tools: OpenAI tool_calls round trip', async () => {
  const sent = [];
  let n = 0;
  globalThis.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    n++;
    if (n === 1) return { ok: true, data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_transcript', arguments: '{"from":"0:00","to":"1:00"}' } }] } }] } };
    return { ok: true, data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] } };
  };
  const tools = { defs: [{ name: 'read_transcript', description: 'd', input_schema: { type: 'object' } }], run: (name, input) => `${input.from}-${input.to}` };
  const out = await llm.chat({ settings: { openaiKey: 'k', model: 'openai:gpt-5', effort: 'off' }, system: 's', messages: [{ role: 'user', content: 'q' }], tools });
  assert.equal(out.text, 'ok');
  assert.equal(sent[0].body.tools[0].function.name, 'read_transcript');
  const m = sent[1].body.messages;
  assert.equal(m.at(-1).role, 'tool');
  assert.equal(m.at(-1).content, '0:00-1:00');
  assert.equal(m.at(-1).tool_call_id, 'c1');
});

test('assemblers: Anthropic tool_use json + thinking signature, OpenAI tool_calls deltas', () => {
  const a = llm.assembleAnthropic([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'search_transcript', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"x"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  ]);
  assert.deepEqual(a.content[0], { type: 'thinking', thinking: 'hm', signature: 'sig' });
  assert.deepEqual(a.content[1].input, { query: 'x' });
  const o = llm.assembleOpenai([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'transcript', arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
  ]);
  assert.deepEqual(o.choices[0].message.tool_calls[0], { id: 'c1', type: 'function', function: { name: 'read_transcript', arguments: '{"a":1}' } });
});

test('fitHistory drops oldest turns until the window fits, keeps the last, opens with a user turn', () => {
  const big = 'x'.repeat(3.5 * 50000); // 50k tokens each
  const msgs = [
    { role: 'user', content: big }, { role: 'assistant', content: big },
    { role: 'user', content: big }, { role: 'assistant', content: 'short' },
    { role: 'user', content: 'last?' },
  ];
  const fit = llm.fitHistory({ modelId: 'claude-haiku-4-5', system: '', messages: msgs }); // 200k window → 144k budget
  assert.equal(fit.dropped, 2);
  assert.equal(fit.messages[0].role, 'user');
  assert.equal(fit.messages.at(-1).content, 'last?');
  assert.deepEqual(llm.fitHistory({ modelId: 'claude-sonnet-5', messages: msgs }).dropped, 0);
  assert.equal(llm.fitHistory({ modelId: 'gpt-4o', messages: [{ role: 'user', content: big }, { role: 'user', content: big }, { role: 'user', content: big }] }).messages.length, 1);
});
