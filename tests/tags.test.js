import test from 'node:test';
import assert from 'node:assert/strict';
import { normTag, extractTags, parseTagList, tagHue, configureTagColors } from '../src/lib/tags.js';

test('normTag: strips #, lowercases, spaces → dashes, keeps nesting, drops junk', () => {
  assert.equal(normTag('#Machine Learning'), 'machinelearning'); // spaces dropped (the editor refuses them up front)
  assert.equal(tagHue('ml'), tagHue('ml'));
  assert.ok(tagHue('ml') >= 0 && tagHue('ml') < 360 && tagHue('ml') !== tagHue('rust'));
  const saved = [];
  configureTagColors({ ml: 200 }, (m) => saved.push(m));
  assert.equal(tagHue('ml'), 200); // kept forever
  const h1 = tagHue('rust'); // new: golden-angle step from the count, persisted
  assert.equal(h1, Math.round(137.508 % 360));
  assert.equal(tagHue('rust'), h1);
  assert.deepEqual(saved.at(-1), { ml: 200, rust: h1 });
  configureTagColors(null, null);
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
