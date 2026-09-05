import test from 'node:test';
import assert from 'node:assert/strict';
import { clip, addFact, dropFacts, MAX_CHARS, MAX_LINES } from '../src/lib/memory.js';

test('clip keeps whole bullets, newest first, under the caps', () => {
  const many = Array.from({ length: 20 }, (_, i) => `- fact ${i}`).join('\n');
  const out = clip(many).split('\n');
  assert.equal(out.length, MAX_LINES);
  assert.equal(out[0], '- fact 0');
  const long = Array.from({ length: 5 }, (_, i) => `- ${'x'.repeat(400)} ${i}`).join('\n');
  assert.ok(clip(long).length <= MAX_CHARS);
  assert.equal(clip(long).split('\n').length, 2);
  assert.equal(clip('plain line\n\n* star'), '- plain line\n- star');
});

test('addFact prepends and dedupes; dropFacts removes by words', () => {
  const m = addFact('- Likes bullets\n- Backend dev', 'Backend dev.');
  assert.equal(m, '- Backend dev.\n- Likes bullets');
  assert.equal(addFact(m, '  '), m);
  const r = dropFacts(m, 'backend DEV');
  assert.deepEqual(r, { text: '- Likes bullets', removed: 1 });
  assert.deepEqual(dropFacts(m, ''), { text: m, removed: 0 });
});
