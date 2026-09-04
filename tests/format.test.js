import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, clampText, chunkText } from '../src/lib/format.js';

test('fmtTime', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(65), '1:05');
  assert.equal(fmtTime(3671), '1:01:11');
  assert.equal(fmtTime(59.9), '0:59');
});

test('clampText no cut', () => {
  assert.equal(clampText('hello', 10), 'hello');
  assert.equal(clampText('hello', 5), 'hello');
});

test('clampText cut', () => {
  const out = clampText('hello world', 8);
  assert.equal(out, 'hello w…');
  assert.ok(out.length <= 8);
});

test('chunkText respects size, no empties', () => {
  const str = 'aaaa bbbb cccc dddd eeee';
  const chunks = chunkText(str, 10);
  for (const c of chunks) {
    assert.ok(c.length <= 10);
    assert.ok(c.trim().length > 0);
  }
  assert.equal(chunks.join(' '), str);
});

test('chunkText splits at word boundary', () => {
  const chunks = chunkText('hello world', 8);
  assert.deepEqual(chunks, ['hello', 'world']);
});

test('chunkText hard-splits when no whitespace', () => {
  const chunks = chunkText('abcdefghij', 4);
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
});
