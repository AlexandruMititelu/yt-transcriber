import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex } from '../src/lib/search.js';

test('bm25: rare query words outrank common ones, no-hit docs dropped, k respected', () => {
  const docs = [
    { start: 0, text: 'the cat sat on the mat' },
    { start: 20, text: 'the dog sat on the log' },
    { start: 40, text: 'quantum entanglement of the cat' },
    { start: 60, text: 'nothing here' },
  ];
  const idx = createIndex(docs);
  const r = idx.search('quantum cat');
  assert.equal(r[0].start, 40); // both words
  assert.equal(r[1].start, 0); // cat only
  assert.equal(r.length, 2);
  assert.equal(idx.search('cat', 1).length, 1);
  assert.deepEqual(idx.search('zebra'), []);
  assert.deepEqual(createIndex([]).search('x'), []);
});
