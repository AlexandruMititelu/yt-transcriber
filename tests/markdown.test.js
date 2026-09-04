import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom.js';
installDom();
const { mathToHtml } = await import('../src/ui/markdown.js');

test('mathToHtml: display and inline math become placeholders; code, currency and bare numbers stay', () => {
  const out = mathToHtml('Let $x_1 = \\frac{a}{b}$ and\n$$\\sum_{i=1}^n i$$\nin `$not$` and ```\n$$no$$\n``` costs $5 and $7, $5$.');
  assert.match(out, /<span class="ytx-math" data-tex="x_1 = \\frac\{a\}\{b\}">/);
  assert.match(out, /<span class="ytx-math ytx-math-display" data-tex="\\sum_\{i=1\}\^n i" data-display="1">/);
  assert.ok(out.includes('`$not$`') && out.includes('$$no$$'), 'code untouched');
  assert.ok(out.includes('costs $5 and $7, $5$.'), 'money and bare numbers untouched');
  assert.equal(mathToHtml('a + b = c'), 'a + b = c');
});
