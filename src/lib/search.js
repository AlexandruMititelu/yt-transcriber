// BM25 keyword search over transcript groups ({start, end, text}). Pure, no deps.
// ponytail: no stemming or stopwords (words < 2 chars dropped); the model retries with synonyms.
const tok = (s) => String(s).toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 1);

export function createIndex(docs) {
  const tf = docs.map((d) => {
    const m = new Map();
    for (const w of tok(d.text)) m.set(w, (m.get(w) || 0) + 1);
    return m;
  });
  const df = new Map();
  for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const avg = len.reduce((a, b) => a + b, 0) / (len.length || 1);
  const N = docs.length, k1 = 1.2, b = 0.75;
  return {
    search(query, k = 8) {
      const q = [...new Set(tok(query))];
      return docs
        .map((d, i) => ({
          ...d,
          score: q.reduce((s, w) => {
            const f = tf[i].get(w);
            if (!f) return s;
            const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
            return s + idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[i] / avg));
          }, 0),
        }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}
