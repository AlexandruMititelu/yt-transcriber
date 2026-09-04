import test from 'node:test';
import assert from 'node:assert/strict';
import { normTag, extractTags, parseTagList } from '../src/lib/tags.js';

test('normTag: strips #, lowercases, spaces → dashes, keeps nesting, drops junk', () => {
  assert.equal(normTag('#Machine Learning'), 'machine-learning');
  assert.equal(normTag(' ml/transformers/ '), 'ml/transformers');
  assert.equal(normTag('c++!'), 'c');
});

test('extractTags: inline tags only, not headings, urls or numbers', () => {
  assert.deepEqual(extractTags('# Title\nsee #ml and (#rust) https://x.y/#anchor #2024 #ML'), ['ml', 'rust']);
  assert.deepEqual(extractTags(''), []);
});

test('parseTagList: array, flow, plain, hashes, raw block', () => {
  assert.deepEqual(parseTagList(['A', '#b']), ['a', 'b']);
  assert.deepEqual(parseTagList('[ml, rust]'), ['ml', 'rust']);
  assert.deepEqual(parseTagList('ml, rust'), ['ml', 'rust']);
  assert.deepEqual(parseTagList('#ml #rust'), ['ml', 'rust']);
  assert.deepEqual(parseTagList('tags:\n  - ml\n  - "rust"'), ['ml', 'rust']);
  assert.deepEqual(parseTagList(''), []);
});
