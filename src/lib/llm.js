// Provider-agnostic LLM service (Anthropic / OpenAI) over the background HTTP proxy.

import { http, stream } from './bus.js';
import * as db from './db.js';
import { fmtTime } from './format.js';
import { createIndex } from './search.js';

export const PROVIDERS = ['anthropic', 'openai'];
export const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5', openai: 'gpt-5.1' };
// Used when /v1/models can't be reached.
export const FALLBACK_MODELS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
};
export const EFFORTS = ['off', 'low', 'medium', 'high'];
const THINKING_BUDGET = { low: 4000, medium: 12000, high: 32000 }; // pre-4.6 models only
// Claude 4.6+ (Opus/Sonnet 4.6-4.8, Opus 5, Sonnet 5, Fable/Mythos 5.x): adaptive thinking +
// output_config.effort; budget_tokens returns 400. Fable/Mythos also 400 on thinking.type 'disabled'.
const ADAPTIVE_RE = /claude-(opus|sonnet)-4-[6-9]|claude-(opus|sonnet)-5|claude-(fable|mythos)/;
const ALWAYS_THINKS_RE = /claude-(fable|mythos)/;

// Context window (tokens) by model id, first hit wins. ponytail: name heuristics; extend when a model
// overflows ("prompt is too long" 400). 1M: Claude Opus/Sonnet 4.6+, 5.x, Fable/Mythos, GPT-4.1, GPT-5.5+.
const WINDOWS = [
  [/claude-(opus|sonnet)-4-[6-9]|claude-(opus|sonnet)-5|claude-(fable|mythos)/, 1e6],
  [/claude-/, 200000],
  [/gpt-4\.1|gpt-5\.[5-9]/, 1e6],
  [/gpt-5/, 400000],
  [/gpt-4o|^o[134]/, 128000],
];
export const DEFAULT_WINDOW = 128000;
export function contextWindow(modelId) {
  const row = WINDOWS.find(([re]) => re.test(String(modelId || '')));
  return row ? row[1] : DEFAULT_WINDOW;
}
export const CHARS_PER_TOKEN = 3.5;
// Max transcript chars in the prompt: 20% of the window. Past that the model searches the transcript
// (transcriptTools) instead: cheaper per turn and recall degrades well before the window fills (context rot).
export const PROMPT_SHARE = 0.2;
export function contextCap(modelId) {
  return Math.round(contextWindow(modelId) * PROMPT_SHARE * CHARS_PER_TOKEN);
}
export const PROMPT_CAP = contextCap('');

// Share of the transcript that fits under cap (1 = all of it).
export function promptCoverage(segments, cap = PROMPT_CAP) {
  const total = (segments ?? []).reduce((n, s) => n + s.text.length + 10, 0);
  return total <= cap ? 1 : cap / total;
}

// Thinking/reasoning support by model id. ponytail: name heuristics, extend when a model errors.
export function supportsEffort(provider, id) {
  if (provider === 'anthropic') return !/claude-3-[05]|claude-2|claude-instant/.test(id);
  if (provider === 'openai') return /^(gpt-5|o\d)/.test(id);
  return false;
}

export function parseModel(str) {
  const i = String(str || '').indexOf(':');
  if (i < 0) return { provider: 'anthropic', id: str || DEFAULT_MODELS.anthropic };
  return { provider: str.slice(0, i), id: str.slice(i + 1) };
}

export const keyFor = (settings, provider) => settings[`${provider}Key`] || '';
export const availableProviders = (settings) => PROVIDERS.filter((p) => keyFor(settings, p));

function anthropicHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

// Server-side web search (Anthropic runs the searches; results come back as citations).
// Opus 4.6+ / Sonnet 4.6+ / 5 take the 2026-02-09 variant (dynamic filtering); older models the basic one.
export function webSearchTool(modelId) {
  const type = ADAPTIVE_RE.test(modelId) ? 'web_search_20260209' : 'web_search_20250305';
  return { type, name: 'web_search', max_uses: 5 };
}

// "12:34" | "1:02:03" | 754 → seconds
export const parseTime = (v) => {
  if (typeof v === 'number') return Math.max(0, v);
  const p = String(v ?? '').trim().split(':').map(Number);
  return p.length && !p.some(isNaN) ? Math.max(0, p.reduce((a, n) => a * 60 + n, 0)) : 0;
};

const READ_MAX = 600; // seconds per read_transcript call (~150 lines)
// Transcript bigger than the prompt cap: the model pulls what it needs. → { defs, run(name, input) → string }
export function transcriptTools(segments) {
  const idx = createIndex(segments);
  const line = (s) => `[${fmtTime(s.start)}] ${s.text}`;
  const defs = [
    {
      name: 'search_transcript',
      description: 'Keyword search over the whole transcript (BM25, exact words only, no synonyms). Returns the best matching passages with timestamps. Run several narrow queries and try synonyms; then read_transcript around the hits for context.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' } }, required: ['query'] },
    },
    {
      name: 'read_transcript',
      description: `Read the transcript verbatim between two times, at most ${READ_MAX / 60} minutes per call.`,
      input_schema: {
        type: 'object',
        properties: { from: { type: 'string', description: 'Start, "h:mm:ss" or seconds' }, to: { type: 'string', description: 'End, "h:mm:ss" or seconds' } },
        required: ['from', 'to'],
      },
    },
  ];
  const run = (name, input = {}) => {
    if (name === 'search_transcript') {
      const hits = idx.search(String(input.query ?? '')).sort((a, b) => a.start - b.start);
      return hits.length ? hits.map(line).join('\n') : 'No matches. Try other words.';
    }
    if (name === 'read_transcript') {
      const from = parseTime(input.from);
      const to = Math.min(parseTime(input.to), from + READ_MAX);
      const rows = segments.filter((s) => s.end > from && s.start < to);
      return rows.length ? rows.map(line).join('\n') : 'Nothing in that range.';
    }
    return `Unknown tool ${name}`;
  };
  return { defs, run };
}

// Oldest turns dropped until system + history fit ~80% of the model's window (reserve for the reply).
// ponytail: chars/3.5 estimate, 1600 tokens per image; the API's "prompt is too long" 400 is the backstop.
export function fitHistory({ modelId, system = '', messages, reserve = 16000 }) {
  const tokens = (m) => Math.ceil(String(m.content).length / CHARS_PER_TOKEN) + (m.image ? 1600 : 0);
  const budget = contextWindow(modelId) * 0.8 - system.length / CHARS_PER_TOKEN - reserve;
  const out = messages.slice();
  let total = out.reduce((n, m) => n + tokens(m), 0);
  while (out.length > 1 && total > budget) total -= tokens(out.shift());
  while (out.length > 1 && out[0].role !== 'user') out.shift(); // history must open with a user turn
  return { messages: out, dropped: messages.length - out.length };
}

// UI messages {role, content, image?} → provider content. `image` is a data: URL (frame capture).
export function toApiMessages(provider, messages) {
  return messages.map(({ role, content, image }) => {
    if (!image) return { role, content };
    const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(image) ?? [, 'image/jpeg', ''];
    const img = provider === 'anthropic'
      ? { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
      : { type: 'image_url', image_url: { url: image } };
    return { role, content: [img, { type: 'text', text: content }] };
  });
}

export function buildRequest({ provider, apiKey, model, system, messages, maxTokens = 4096, effort = 'off', webSearch = false, streaming = false, tools = null }) {
  const m = model || DEFAULT_MODELS[provider];
  const think = EFFORTS.includes(effort) && effort !== 'off';
  if (provider === 'anthropic') {
    // The system prompt (whole transcript) is identical every turn: cache it, ~90% cheaper multi-turn.
    const sys = system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined;
    const body = { model: m, max_tokens: maxTokens, system: sys, messages: toApiMessages(provider, messages) };
    if (streaming) body.stream = true;
    const t = [...(webSearch ? [webSearchTool(m)] : []), ...(tools ?? [])];
    if (t.length) body.tools = t;
    if (ADAPTIVE_RE.test(m)) {
      if (think) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort };
        body.max_tokens = Math.max(maxTokens, 16000); // thinking tokens count against max_tokens
      } else if (!ALWAYS_THINKS_RE.test(m)) {
        body.thinking = { type: 'disabled' }; // omitting = adaptive on Opus 5 / Sonnet 5
      }
    } else if (think) {
      const budget = THINKING_BUDGET[effort];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(maxTokens, budget + 4096); // must exceed the thinking budget
    }
    return { url: 'https://api.anthropic.com/v1/messages', headers: anthropicHeaders(apiKey), body };
  }
  if (provider === 'openai') {
    const body = { model: m, messages: [{ role: 'system', content: system }, ...toApiMessages(provider, messages)] };
    if (think) body.reasoning_effort = effort;
    if (tools?.length) body.tools = tools.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } }));
    if (webSearch) body.web_search_options = {}; // Chat Completions built-in web search
    if (streaming) { body.stream = true; body.stream_options = { include_usage: true }; }
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      body,
    };
  }
  throw new Error(`unknown provider: ${provider}`);
}

// Unique [title](url) lines appended under "Sources:" when the model cited web results.
function sourcesBlock(cites) {
  const seen = new Map();
  for (const c of cites) if (c?.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
  if (!seen.size) return '';
  return '\n\nSources:\n' + [...seen].map(([url, title]) => `- [${title}](${url})`).join('\n');
}

export function parseResponse(provider, json) {
  return parseResult(provider, json).text;
}

const TRUNCATED = '\n\n*[Reply cut off: hit the length limit]*';

// → { text, usage: {in, out, cacheRead}, truncated }
export function parseResult(provider, json) {
  if (provider === 'anthropic') {
    const texts = (json.content ?? []).filter((b) => b.type === 'text');
    const cites = texts.flatMap((b) => b.citations ?? []);
    const u = json.usage ?? {};
    const truncated = json.stop_reason === 'max_tokens';
    return {
      text: texts.map((b) => b.text).join('') + sourcesBlock(cites) + (truncated ? TRUNCATED : ''),
      // `in` = whole prompt (Anthropic reports uncached, cache-read and cache-write separately; OpenAI's prompt_tokens already includes cached).
      usage: {
        in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
      },
      truncated,
    };
  }
  const choice = json.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const cites = (msg.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url_citation);
  const u = json.usage ?? {};
  const truncated = choice.finish_reason === 'length';
  return {
    text: (msg.content ?? '') + sourcesBlock(cites) + (truncated ? TRUNCATED : ''),
    usage: { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0, cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0 },
    truncated,
  };
}

// USD per million tokens [input, output]; unknown models show token counts only.
// ponytail: hand-maintained, matched by substring, first hit wins.
const PRICES = [
  ['claude-opus-4', 15, 75], ['claude-sonnet-4', 3, 15], ['claude-haiku-4', 1, 5],
  ['gpt-5-nano', 0.05, 0.4], ['gpt-5-mini', 0.25, 2], ['gpt-5', 1.25, 10],
];
export function estimateCost(modelId, usage) {
  const row = PRICES.find(([k]) => String(modelId).includes(k));
  if (!row || !usage) return null;
  const [, pin, pout] = row;
  const cached = usage.cacheRead || 0;
  return ((usage.in - cached) * pin + cached * pin * 0.1 + usage.out * pout) / 1e6;
}
export const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export function fmtUsage(modelId, usage) {
  if (!usage) return '';
  const k = fmtK;
  const cost = estimateCost(modelId, usage);
  return `${k(usage.in)} in · ${k(usage.out)} out${cost != null ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : ''}`;
}

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// Anthropic SSE events → the same JSON shape a non-streaming call returns. Pure; fed by chat().
export function assembleAnthropic(events, onText) {
  const out = { content: [], stop_reason: null, usage: {} };
  for (const ev of events) {
    if (ev.type === 'message_start') Object.assign(out.usage, ev.message?.usage ?? {});
    else if (ev.type === 'content_block_start') out.content[ev.index] = { ...ev.content_block };
    else if (ev.type === 'content_block_delta') {
      const b = out.content[ev.index] ?? (out.content[ev.index] = { type: 'text', text: '' });
      const d = ev.delta ?? {};
      if (d.type === 'text_delta') { b.text = (b.text ?? '') + d.text; if (onText) onText(d.text); }
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') b._json = (b._json ?? '') + d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const b = out.content[ev.index];
      if (b && '_json' in b) { b.input = safeJson(b._json); delete b._json; }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) out.stop_reason = ev.delta.stop_reason;
      Object.assign(out.usage, ev.usage ?? {});
    }
  }
  out.content = out.content.filter(Boolean);
  return out;
}

// OpenAI chat-completions chunks → non-streaming shape.
export function assembleOpenai(chunks, onText) {
  const msg = { role: 'assistant', content: '', annotations: [] };
  let finish = null;
  let usage = null;
  for (const c of chunks) {
    const ch = c.choices?.[0];
    if (ch?.delta?.content) { msg.content += ch.delta.content; if (onText) onText(ch.delta.content); }
    if (ch?.delta?.annotations) msg.annotations.push(...ch.delta.annotations);
    for (const tc of ch?.delta?.tool_calls ?? []) {
      const cur = (msg.tool_calls ??= [])[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (c.usage) usage = c.usage;
  }
  return { choices: [{ message: msg, finish_reason: finish }], usage };
}

// retrieval: transcript left out, model gets duration + chapters and the transcript tools instead.
export function buildSystemPrompt({ title, channel, segments, aboutMe = '', tone = '', webSearch = false, cap = PROMPT_CAP, retrieval = false, duration = 0, chapters = [] }) {
  const lines = (segments ?? [])
    .map((s) => `[${fmtTime(s.start)}] ${s.text}`)
    .join('\n');
  let prompt =
    `You are an assistant for the YouTube video "${title}" by ${channel}. ` +
    'Answer questions about this video using its transcript below. ' +
    'You may answer with markdown, and may draw diagrams in ```mermaid fenced blocks. ' +
    'Cite timestamps like [12:34] when referencing the video. ' +
    'Write maths in LaTeX: $…$ inline and $$…$$ on its own line for anything with fractions, roots, sums, integrals, ' +
    'subscripts, Greek letters or matrices; trivial arithmetic like a + b = c or 3 × 4 stays plain text. ' +
    'Never use em dashes or double hyphens (--); use commas, periods, or colons instead.\n\n';
  if (webSearch) {
    prompt +=
      'You can search the web. Use it when the answer needs facts beyond the transcript: people, papers, ' +
      'products, tools, prices, dates, current events, or claims worth verifying. Write focused queries ' +
      'that reuse the exact names and terms from the video, run several narrow searches rather than one ' +
      'broad one, and say what you found and where. Stay on the transcript alone for questions it already answers.\n\n';
  }
  if (aboutMe.trim()) prompt += `About the user:\n${aboutMe.trim()}\n\n`;
  if (tone.trim()) prompt += `Tone of voice:\n${tone.trim()}\n\n`;
  if (retrieval) {
    prompt +=
      `The transcript (${fmtTime(duration)} long) is too big to include here. Use search_transcript to find passages by ` +
      'keywords (several narrow queries, try synonyms), then read_transcript to read verbatim around the hits. ' +
      'Search before answering anything about specific content; for overviews, read the chapters in turn. ' +
      'Say so when a search finds nothing.\n\n' +
      (chapters.length ? 'Chapters:\n' + chapters.map((c) => `[${fmtTime(c.start)}] ${c.title}`).join('\n') : 'No chapters.');
    return prompt;
  }
  prompt += 'Transcript:\n' + lines;
  if (prompt.length <= cap) return prompt;
  return prompt.slice(0, cap) + '\n[transcript truncated]';
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request, streamed when `onText` is given (deltas arrive as they are generated), with one retry
// on rate limit / overload. → the provider's non-streaming JSON.
// onTool(name, input, phase): phase 'start' when a tool block opens mid-stream (server-side web search, our
// transcript tools), 'result' when its result block arrives. Input is not known yet at 'start'.
async function request(provider, req, { onText, signal, onTool } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    if (onText) {
      const events = [];
      r = await stream(req.url, { method: 'POST', headers: req.headers, body: req.body }, {
        signal,
        onEvent: (ev) => {
          events.push(ev);
          if (provider === 'anthropic') {
            const d = ev.delta;
            if (ev.type === 'content_block_delta' && d?.type === 'text_delta') onText(d.text);
            else if (ev.type === 'content_block_start' && onTool) {
              const b = ev.content_block ?? {};
              if (b.type === 'server_tool_use' || b.type === 'tool_use') onTool(b.name, {}, 'start');
              else if (/_tool_result$/.test(b.type ?? '')) onTool(b.type.replace(/_tool_result$/, ''), {}, 'result');
            }
          } else if (ev.choices?.[0]?.delta?.content) onText(ev.choices[0].delta.content);
        },
      });
      if (r.ok) return provider === 'anthropic' ? assembleAnthropic(events) : assembleOpenai(events);
    } else {
      r = await http(req.url, { method: 'POST', headers: req.headers, body: req.body });
      if (r.ok) return r.data;
    }
    if (signal?.aborted) throw new Error('cancelled');
    if (attempt === 0 && RETRY_STATUS.has(r.status)) { await sleep(2000); continue; }
    throw new Error(r.error);
  }
}

// → { text, usage, model }. `onText(delta)` streams the reply; `signal` (AbortSignal) stops it.
// `tools` = transcriptTools(): the model may call them; rounds are bounded. `onTool(name, input)` for status.
export async function chat({ settings, system, messages, maxTokens, onText, signal, tools = null, onTool }) {
  const { provider, id } = parseModel(settings.model);
  const apiKey = keyFor(settings, provider);
  if (!apiKey) throw new Error('no-api-key');
  const effort = supportsEffort(provider, id) ? settings.effort : 'off';
  const webSearch = !!settings.webSearch;
  const req = buildRequest({ provider, apiKey, model: id, system, messages, maxTokens, effort, webSearch, streaming: !!onText, tools: tools?.defs });
  let data = await request(provider, req, { onText, signal, onTool });
  const msgs = [...req.body.messages];
  const usage = { in: 0, out: 0, cacheRead: 0 }; // ponytail: summed over rounds; `in` over-counts context by earlier rounds
  const pre = []; // text the model wrote before a tool call
  const add = (d) => { const u = parseResult(provider, d); for (const k in usage) usage[k] += u.usage[k]; return u; };
  // Anthropic: pause_turn (server-side web search) → resend the partial turn; tool_use → run our tools.
  // OpenAI: tool_calls → run, append `tool` messages. 10 rounds max so a stuck loop can't run forever.
  for (let i = 0; i < 10; i++) {
    if (provider === 'anthropic') {
      const stop = data?.stop_reason;
      if (stop !== 'pause_turn' && !(stop === 'tool_use' && tools)) break;
      const u = add(data);
      if (u.text) pre.push(u.text);
      msgs.push({ role: 'assistant', content: data.content });
      if (stop === 'tool_use') {
        const results = [];
        for (const b of data.content.filter((b) => b.type === 'tool_use')) {
          onTool?.(b.name, b.input ?? {}, 'run');
          results.push({ type: 'tool_result', tool_use_id: b.id, content: String(await tools.run(b.name, b.input ?? {})) });
        }
        msgs.push({ role: 'user', content: results });
      }
    } else {
      const msg = data?.choices?.[0]?.message;
      if (!msg?.tool_calls?.length || !tools) break;
      const u = add(data);
      if (u.text) pre.push(u.text);
      msgs.push(msg);
      for (const c of msg.tool_calls) {
        const input = safeJson(c.function?.arguments);
        onTool?.(c.function?.name, input, 'run');
        msgs.push({ role: 'tool', tool_call_id: c.id, content: String(await tools.run(c.function?.name, input)) });
      }
    }
    data = await request(provider, { ...req, body: { ...req.body, messages: msgs } }, { onText, signal, onTool });
  }
  const out = add(data);
  out.usage = usage;
  if (pre.length) out.text = [...pre, out.text].filter(Boolean).join('\n\n');
  out.model = id;
  return out;
}

// OpenAI lists everything (audio, embeddings, dated snapshots…); keep chat-capable families only.
const OPENAI_KEEP = /^(gpt-\d|o\d)/;
const OPENAI_DROP = /audio|realtime|tts|transcribe|search|instruct|image|embed|moderation|codex|-\d{4}-\d{2}-\d{2}$/;

export function filterModelIds(provider, ids) {
  const out = provider === 'openai' ? ids.filter((id) => OPENAI_KEEP.test(id) && !OPENAI_DROP.test(id)) : ids;
  return [...new Set(out)].sort();
}

// GET /v1/models for one provider → sorted ids. Throws on HTTP/network error.
export async function listModels({ provider, apiKey }) {
  const req = provider === 'anthropic'
    ? { url: 'https://api.anthropic.com/v1/models?limit=100', headers: anthropicHeaders(apiKey) }
    : { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${apiKey}` } };
  const r = await http(req.url, { method: 'GET', headers: req.headers });
  if (!r.ok) throw new Error(r.error);
  return filterModelIds(provider, (r.data?.data ?? []).map((m) => m.id));
}

// Models per provider that has a key: { anthropic: [ids], openai: [ids] }. Cached 24h in
// storage; falls back to FALLBACK_MODELS when the list endpoint fails.
export async function modelGroups(settings) {
  const out = {};
  await Promise.all(availableProviders(settings).map(async (provider) => {
    let ids = await db.getCachedModels(provider);
    if (!ids) {
      try {
        ids = await listModels({ provider, apiKey: keyFor(settings, provider) });
        await db.setCachedModels(provider, ids);
      } catch (e) {
        console.warn('[ytx] model list failed', provider, e.message);
        ids = FALLBACK_MODELS[provider];
      }
    }
    out[provider] = ids;
  }));
  return out;
}

// Ensure settings.model points at a provider with a key. Returns the (possibly changed) model string.
export function resolveModel(settings, groups) {
  const { provider, id } = parseModel(settings.model);
  const providers = Object.keys(groups);
  if (providers.includes(provider)) return `${provider}:${id}`;
  const p = providers[0];
  return p ? `${p}:${DEFAULT_MODELS[p]}` : settings.model;
}

// Short chat title from the first exchange. Effort forced off; errors propagate (callers ignore).
export async function titleChat({ settings, messages }) {
  const sample = messages.slice(0, 2).map((m) => `${m.role}: ${String(m.content).slice(0, 1500)}`).join('\n\n');
  const { text: raw } = await chat({
    settings: { ...settings, effort: 'off' },
    system: 'You title conversations. Reply with a 3-6 word title only: no quotes, no trailing punctuation, no preamble.',
    messages: [{ role: 'user', content: sample }],
    maxTokens: 30,
  });
  return raw.split('\n')[0].replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '').slice(0, 60);
}
