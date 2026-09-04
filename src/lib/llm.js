// Provider-agnostic LLM service (Anthropic / OpenAI) over the background HTTP proxy.

import { http } from './bus.js';
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

const PROMPT_CAP = 24000;

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

export function buildRequest({ provider, apiKey, model, system, messages, maxTokens = 2048, effort = 'off' }) {
  const m = model || DEFAULT_MODELS[provider];
  const think = EFFORTS.includes(effort) && effort !== 'off';
  if (provider === 'anthropic') {
    const body = { model: m, max_tokens: maxTokens, system, messages };
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
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      body,
    };
  }
  throw new Error(`unknown provider: ${provider}`);
}

export function parseResponse(provider, json) {
  if (provider === 'anthropic') {
    return json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  return json.choices?.[0]?.message?.content ?? '';
}

export function buildSystemPrompt({ title, channel, segments, aboutMe = '', tone = '' }) {
  const lines = (segments ?? [])
    .map((s) => `[${fmtTime(s.start)}] ${s.text}`)
    .join('\n');
  let prompt =
    `You are an assistant for the YouTube video "${title}" by ${channel}. ` +
    'Answer questions about this video using its transcript below. ' +
    'You may answer with markdown, and may draw diagrams in ```mermaid fenced blocks. ' +
    'Cite timestamps like [12:34] when referencing the video. ' +
    'Never use em dashes or double hyphens (--); use commas, periods, or colons instead.\n\n';
  if (aboutMe.trim()) prompt += `About the user:\n${aboutMe.trim()}\n\n`;
  if (tone.trim()) prompt += `Tone of voice:\n${tone.trim()}\n\n`;
  prompt += 'Transcript:\n' + lines;
  if (prompt.length <= PROMPT_CAP) return prompt;
  return prompt.slice(0, PROMPT_CAP) + '\n[transcript truncated]';
}

export async function chat({ settings, system, messages, maxTokens }) {
  const { provider, id } = parseModel(settings.model);
  const apiKey = keyFor(settings, provider);
  if (!apiKey) throw new Error('no-api-key');
  const effort = supportsEffort(provider, id) ? settings.effort : 'off';
  const req = buildRequest({ provider, apiKey, model: id, system, messages, maxTokens, effort });
  const r = await http(req.url, { method: 'POST', headers: req.headers, body: req.body });
  if (!r.ok) throw new Error(r.error);
  return parseResponse(provider, r.data);
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
  const raw = await chat({
    settings: { ...settings, effort: 'off' },
    system: 'You title conversations. Reply with a 3-6 word title only: no quotes, no trailing punctuation, no preamble.',
    messages: [{ role: 'user', content: sample }],
    maxTokens: 30,
  });
  return raw.split('\n')[0].replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '').slice(0, 60);
}
