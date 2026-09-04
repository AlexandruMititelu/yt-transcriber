import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote } from '../src/ui/quote.js';

test('buildQuote: blockquote per line + source line', () => {
  assert.equal(buildQuote(' a\nb ', '[1:02](u)'), '> a\n> b\n> — [1:02](u)');
});
