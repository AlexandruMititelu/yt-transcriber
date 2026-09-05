// LLM usage ledger: one row per call, appended by llm.chat(). storage.local `usage` is the ledger; when the vault
// is on it is mirrored to <vault>/YT-transcriber/admin/usage.csv (every row) and admin/Usage.md (summary).
// Row: { ts, provider, model, kind: 'chat'|'title'|'test'|'memory', videoId, effort, web, in, out, cacheRead, cacheWrite, searches, ms, cost|null }

import * as db from './db.js';
import * as vault from './vault.js';
import { fmtCost, fmtK } from './llm.js';

export const CSV_FILE = 'usage.csv';
export const MD_FILE = 'Usage.md';

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clockOf = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

export const COLUMNS = ['ts_iso', 'date', 'time', 'hour', 'weekday', 'provider', 'model', 'kind', 'video_id', 'effort', 'web_search',
  'in_tokens', 'out_tokens', 'cache_read', 'cache_write', 'searches', 'duration_ms', 'cost_usd'];

const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function toCsv(rows) {
  const lines = rows.map((r) => [new Date(r.ts).toISOString(), dayOf(r.ts), clockOf(r.ts), new Date(r.ts).getHours(), DAYS[new Date(r.ts).getDay()],
    r.provider, r.model, r.kind, r.videoId, r.effort, r.web ? 1 : 0,
    r.in, r.out, r.cacheRead, r.cacheWrite, r.searches, r.ms, r.cost == null ? '' : r.cost.toFixed(6)].map(cell).join(','));
  return [COLUMNS.join(','), ...lines].join('\n') + '\n';
}

const sum = (rows) => rows.reduce((a, r) => ({ calls: a.calls + 1, in: a.in + (r.in || 0), out: a.out + (r.out || 0), cacheRead: a.cacheRead + (r.cacheRead || 0),
  cost: a.cost + (r.cost || 0), unpriced: a.unpriced + (r.cost == null ? 1 : 0) }), { calls: 0, in: 0, out: 0, cacheRead: 0, cost: 0, unpriced: 0 });

// → { periods: [{label, ...totals}], byModel: [{model, ...totals}] (cost desc), byDay: [{day, ...totals}] (last 30, newest first) }
export function report(rows, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const since = (ms) => rows.filter((r) => r.ts >= ms);
  const periods = [['Today', since(midnight.getTime())], ['7 days', since(now - 7 * 864e5)], ['30 days', since(now - 30 * 864e5)], ['All time', rows]]
    .map(([label, rs]) => ({ label, ...sum(rs) }));
  const group = (key) => { const m = new Map(); for (const r of rows) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))).push(r); return m; };
  const byModel = [...group((r) => `${r.provider}:${r.model}`)].map(([model, rs]) => ({ model, ...sum(rs) })).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const byDay = [...group((r) => dayOf(r.ts))].map(([day, rs]) => ({ day, ...sum(rs) })).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30);
  return { periods, byModel, byDay };
}

const costCell = (t) => (t.cost || !t.unpriced ? fmtCost(t.cost) : '') + (t.unpriced ? ` (${t.unpriced} unpriced)` : '');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const tot = (t) => [t.calls, fmtK(t.in), fmtK(t.out), fmtK(t.cacheRead), costCell(t)];

export function reportToMd(rep, now = Date.now()) {
  const head = ['Calls', 'In', 'Out', 'Cached', 'Cost'];
  return `# LLM usage\n\nUpdated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC. Costs are estimates from the price table in Settings; every call is in \`${CSV_FILE}\` next to this file.\n\n` +
    `## Totals\n\n${table(['Period', ...head], rep.periods.map((p) => [p.label, ...tot(p)]))}\n\n` +
    `## By model\n\n${table(['Model', ...head], rep.byModel.map((m) => [m.model, ...tot(m)]))}\n\n` +
    `## By day (last 30)\n\n${table(['Day', ...head], rep.byDay.map((d) => [d.day, ...tot(d)]))}\n`;
}

// Rewrite both admin files from the whole ledger. No-op without a vault.
// ponytail: whole-file rewrite per call (~100 B/row); an append op in the host if the csv gets to many MB.
export async function mirror(settings, rows) {
  if (!vault.enabled(settings)) return;
  rows ??= await db.getUsage();
  await vault.writeAdmin(settings, CSV_FILE, toCsv(rows));
  await vault.writeAdmin(settings, MD_FILE, reportToMd(report(rows)));
}

export async function log(settings, row) {
  const rows = await db.appendUsage(row);
  await mirror(settings, rows);
}
