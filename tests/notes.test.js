import test from 'node:test';
import assert from 'node:assert/strict';

const notes = await import('../src/ui/notes.js');
const { hotkeyId } = await import('../config/hotkeys.js');

test('hotkeyId: notes hotkeys, Alt+Shift+Enter → focusVideo, other shift/ctrl combos → null', () => {
  const key = (k, extra = {}) => ({ key: k, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
  assert.equal(hotkeyId(key('q')), 'quickNote');
  assert.equal(hotkeyId(key('Enter')), 'toggleNote');
  assert.equal(hotkeyId(key("'")), 'prevNote');
  assert.equal(hotkeyId(key('\\')), 'nextNote');
  assert.equal(hotkeyId(key('Enter', { shiftKey: true })), 'focusVideo');
  assert.equal(hotkeyId(key('q', { shiftKey: true })), null);
  assert.equal(hotkeyId(key('e', { ctrlKey: true })), null);
});

test('normalizeStamps: @now → current time, @m:ss → @mm:ss, h:mm:ss untouched', () => {
  assert.equal(notes.normalizeStamps('at @now ok', 137), 'at @02:17 ok');
  assert.equal(notes.normalizeStamps('see @2:17 and @12:05', null), 'see @02:17 and @12:05');
  assert.equal(notes.normalizeStamps('@1:02:03 stays', null), '@1:02:03 stays');
  assert.equal(notes.normalizeStamps('@now', null), '@now', 'no clock → left alone');
  assert.equal(notes.normalizeStamps('@nowhere', 5), '@nowhere');
  assert.equal(notes.stampFmt(3723), '1:02:03');
  assert.equal(notes.stampFmt(59), '00:59');
});

test('excerpt: first sentence, markdown stripped, capped', () => {
  assert.equal(notes.excerpt('# Title\n\n**Bold** first. Second sentence.'), 'Title Bold first.');
  assert.equal(notes.excerpt('- item one\n- item two'), 'item one item two');
  assert.equal(notes.excerpt('x'.repeat(400)).length, 280);
});

test('parsePrompts: "Label: text" lines, defaults when unset, none when empty', async () => {
  const { parsePrompts, PROMPTS, promptsToText } = await import('../config/prompts.js');
  assert.deepEqual(parsePrompts(undefined), PROMPTS);
  assert.deepEqual(parsePrompts(''), []);
  assert.deepEqual(parsePrompts('Sum: Summarize it\nbad line\nX: y: z'), [{ label: 'Sum', text: 'Summarize it' }, { label: 'X', text: 'y: z' }]);
  assert.deepEqual(parsePrompts(promptsToText(PROMPTS)), PROMPTS);
});
