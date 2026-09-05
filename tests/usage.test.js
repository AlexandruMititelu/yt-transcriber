import test from 'node:test';
import assert from 'node:assert/strict';

// storage.local Map + native host that records writes.
const store = new Map();
const files = new Map();
globalThis.browser = {
  storage: { local: {
    async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    async remove(k) { store.delete(k); },
  } },
  runtime: { async sendMessage(msg) {
    if (msg.type !== 'native') return { ok: false, error: 'unmocked' };
    if (!msg.root) return { ok: false, error: 'missing root' };
    if (msg.op === 'write') { files.set(msg.path, msg.content); return { ok: true, mtime: 1 }; }
    return { ok: false, error: `unexpected op ${msg.op}` };
  } },
};

const usage = await import('../src/lib/usage.js');
const llm = await import('../src/lib/llm.js');
const db = await import('../src/lib/db.js');

const ts = Date.UTC(2026, 8, 5, 10, 30, 0); // 2026-09-05 10:30 UTC
const row = (over = {}) => ({ ts, provider: 'anthropic', model: 'claude-sonnet-5', kind: 'chat', videoId: 'v1', effort: 'off', web: false,
  in: 1000, out: 100, cacheRead: 0, cacheWrite: 0, searches: 0, ms: 1200, cost: 0.0045, ...over });

test('toCsv: header, one line per row, local date/time columns, quoting', () => {
  const csv = usage.toCsv([row({ model: 'weird,"model"', cost: null })]);
  const [head, line, tail] = csv.split('\n');
  assert.equal(head, usage.COLUMNS.join(','));
  assert.equal(tail, '');
  const d = new Date(ts);
  assert.ok(line.startsWith(`${d.toISOString()},${usage.dayOf(ts)},`));
  assert.ok(line.includes(`,${d.getHours()},`));
  assert.ok(line.includes('"weird,""model"""'));
  assert.ok(line.endsWith(',1200,')); // unpriced → empty cost cell
  assert.ok(usage.toCsv([row()]).includes(',1200,0.004500'));
});

test('report: periods, by model (cost desc), by day; unpriced counted', () => {
  const now = ts + 3600e3;
  const rows = [
    row(), // today
    row({ ts: ts - 3 * 864e5, model: 'gpt-5', provider: 'openai', cost: 0.02, in: 5000 }), // 3 days ago
    row({ ts: ts - 40 * 864e5, model: 'old', cost: null }), // outside 30d, unpriced
  ];
  const rep = usage.report(rows, now);
  const by = Object.fromEntries(rep.periods.map((p) => [p.label, p]));
  assert.equal(by.Today.calls, 1);
  assert.equal(by['7 days'].calls, 2);
  assert.equal(by['30 days'].in, 6000);
  assert.equal(by['All time'].calls, 3);
  assert.equal(by['All time'].unpriced, 1);
  assert.ok(Math.abs(by['All time'].cost - 0.0245) < 1e-9);
  assert.deepEqual(rep.byModel.map((m) => m.model), ['openai:gpt-5', 'anthropic:claude-sonnet-5', 'anthropic:old']);
  assert.equal(rep.byDay.length, 3);
  assert.equal(rep.byDay[0].day, usage.dayOf(ts)); // newest first
  const md = usage.reportToMd(rep, now);
  assert.ok(md.includes('| Today | 1 | 1.0k | 100 | 0 | $0.0045 |'));
  assert.ok(md.includes('openai:gpt-5'));
  assert.ok(md.includes('(1 unpriced)'));
});

test('estimateCost: cache write 125%, cache read 10%, web searches, editable prices', () => {
  const u = { in: 10000, out: 0, cacheRead: 5000, cacheWrite: 4000, searches: 2 };
  // 1000 plain + 5000×0.1 + 4000×1.25 = 6500 token-equivalents at $3/M = 0.0195, + 2 searches × $0.01 = 0.0395
  assert.ok(Math.abs(llm.estimateCost('claude-sonnet-5', u) - 0.0395) < 1e-9);
  assert.equal(llm.estimateCost('mystery-model', u), null);
  assert.equal(llm.estimateCost('mystery-model', { in: 1e6, out: 0 }, llm.parsePrices('mystery 2 4\njunk line')), 2);
  assert.deepEqual(llm.parsePrices(''), llm.parsePrices(llm.DEFAULT_PRICES));
  assert.equal(llm.fmtUsage('x', { in: 10, out: 1, cost: 0.5 }), '10 in · 1 out · $0.500'); // stored cost wins
});

test('log: appends to storage and mirrors csv + md under <root>/admin when the vault is on', async () => {
  await usage.log({ vaultDir: '' }, row());
  assert.equal((await db.getUsage()).length, 1);
  assert.equal(files.size, 0);
  await usage.log({ vaultDir: 'C:/Vault' }, row({ kind: 'title' }));
  assert.equal((await db.getUsage()).length, 2);
  assert.ok(files.get('C:/Vault/YT-transcriber/admin/usage.csv').split('\n').length === 4); // header + 2 rows + trailing
  assert.ok(files.get('C:/Vault/YT-transcriber/admin/Usage.md').startsWith('# LLM usage'));
});

test('chat() writes a ledger row with kind/videoId/effort/duration and a priced usage', async () => {
  store.clear();
  browser.runtime.sendMessage = async (msg) => {
    if (msg.type === 'http') return { ok: true, data: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } };
    return { ok: false, error: 'no vault' };
  };
  const r = await llm.chat({ settings: { anthropicKey: 'k', model: 'anthropic:claude-sonnet-5', effort: 'low', prices: 'claude-sonnet-5 10 100' }, system: 's', messages: [{ role: 'user', content: 'q' }], meta: { videoId: 'vid' } });
  assert.ok(Math.abs(r.usage.cost - (100 * 10 + 50 * 10 * 0.1 + 10 * 100) / 1e6) < 1e-12);
  await new Promise((res) => setTimeout(res, 0)); // log() is fire-and-forget
  const [l] = await db.getUsage();
  assert.equal(l.kind, 'chat');
  assert.equal(l.videoId, 'vid');
  assert.equal(l.effort, 'low');
  assert.equal(l.in, 150);
  assert.equal(l.cacheRead, 50);
  assert.equal(typeof l.ms, 'number');
});
