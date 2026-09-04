// Provider-agnostic LLM service (Anthropic / OpenAI) over the background HTTP proxy.

import { http, stream } from './bus.js';
import * as db from './db.js';
import { fmtTime } from './format.js';

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

export const PROMPT_CAP = 24000;

// Max prompt chars for a model's context window. ponytail: substring heuristic (~3.5 chars/token,
// 60% of the window reserved for the prompt), matched first-hit-wins; extend when a model overflows.
const CONTEXT_CAPS = [
  ['claude-', 420000],  // 200k tokens
  ['gpt-5', 840000],    // 400k tokens
  ['gpt-4.1', 2000000], // 1M tokens
  ['gpt-4o', 268000],   // 128k tokens
  ['o1', 268000], ['o3', 268000], ['o4', 268000],
];
export function contextCap(modelId) {
  const row = CONTEXT_CAPS.find(([k]) => String(modelId || '').includes(k));
  return row ? row[1] : PROMPT_CAP;
}

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

export function buildRequest({ provider, apiKey, model, system, messages, maxTokens = 4096, effort = 'off', webSearch = false, streaming = false }) {
  const m = model || DEFAULT_MODELS[provider];
  const think = EFFORTS.includes(effort) && effort !== 'off';
  if (provider === 'anthropic') {
    // The system prompt (whole transcript) is identical every turn: cache it, ~90% cheaper multi-turn.
    const sys = system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined;
    const body = { model: m, max_tokens: maxTokens, system: sys, messages };
    if (streaming) body.stream = true;
    if (webSearch) body.tools = [webSearchTool(m)];
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
    const body = { model: m, messages: [{ role: 'system', content: system }, ...messages] };
    if (think) body.reasoning_effort = effort;
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
      usage: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 },
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
export function fmtUsage(modelId, usage) {
  if (!usage) return '';
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const cost = estimateCost(modelId, usage);
  return `${k(usage.in)} in · ${k(usage.out)} out${cost != null ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : ''}`;
}

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
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (c.usage) usage = c.usage;
  }
  return { choices: [{ message: msg, finish_reason: finish }], usage };
}

export function buildSystemPrompt({ title, channel, segments, aboutMe = '', tone = '', webSearch = false, cap = PROMPT_CAP }) {
  const lines = (segments ?? [])
    .map((s) => `[${fmtTime(s.start)}] ${s.text}`)
    .join('\n');
  let prompt =
    `You are an assistant for the YouTube video "${title}" by ${channel}. ` +
    'Answer questions about this video using its transcript below. ' +
    'You may answer with markdown, and may draw diagrams in ```mermaid fenced blocks. ' +
    'Cite timestamps like [12:34] when referencing the video. ' +
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
  prompt += 'Transcript:\n' + lines;
  if (prompt.length <= cap) return prompt;
  return prompt.slice(0, cap) + '\n[transcript truncated]';
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request, streamed when `onText` is given (deltas arrive as they are generated), with one retry
// on rate limit / overload. → the provider's non-streaming JSON.
async function request(provider, req, { onText, signal } = {}) {
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

// → { text, usage }. `onText(delta)` streams the reply; `signal` (AbortSignal) stops it.
export async function chat({ settings, system, messages, maxTokens, onText, signal }) {
  const { provider, id } = parseModel(settings.model);
  const apiKey = keyFor(settings, provider);
  if (!apiKey) throw new Error('no-api-key');
  const effort = supportsEffort(provider, id) ? settings.effort : 'off';
  const webSearch = !!settings.webSearch;
  const req = buildRequest({ provider, apiKey, model: id, system, messages, maxTokens, effort, webSearch, streaming: !!onText });
  let data = await request(provider, req, { onText, signal });
  // Server-side tools may pause after ~10 search iterations: re-send with the partial assistant turn
  // appended (no extra user message) and the server resumes. Bounded so a stuck loop can't run forever.
  for (let i = 0; provider === 'anthropic' && data?.stop_reason === 'pause_turn' && i < 3; i++) {
    const body = { ...req.body, messages: [...req.body.messages, { role: 'assistant', content: data.content }] };
    data = await request(provider, { ...req, body }, { onText, signal });
  }
  const out = parseResult(provider, data);
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
