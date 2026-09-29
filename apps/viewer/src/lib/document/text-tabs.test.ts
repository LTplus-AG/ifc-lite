/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6370: a Text block's line breaks and tab indents reach the PDF as typed.
 * The page layout (`composeDocument`) is what the PDF draws line by line, so
 * these assert on its text items.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, estimateTextWidth, wrapText } from './compose.js';
import { tabEdit, tabFill, TAB_SIZE } from './text-tabs.js';
import type { TextBlock } from './types.js';

const perChar = (text: string): number => text.length;

function pdfLines(style: TextBlock['style'], text: string): string[] {
  const layout = composeDocument({
    name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
    blocks: [{ kind: 'text', id: 't', style, text }],
  });
  return layout.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'text' ? [i.text] : [])))
    .filter((t) => t !== 'Doc' && t !== 'now' && !t.startsWith('Page '));
}

describe('Text block line breaks and indents in the PDF (#6370)', () => {
  for (const style of ['title', 'heading', 'subheading', 'body', 'small', 'caption'] as const) {
    it(`a line break prints as a new line in a ${style}`, () => {
      assert.deepEqual(pdfLines(style, 'Prüfbericht\nBIM-Gesamtkoordination'), ['Prüfbericht', 'BIM-Gesamtkoordination']);
    });
  }

  it('a leading tab prints as an indent, not as nothing', () => {
    const [first, second] = pdfLines('body', 'Contents\n\tWalls');
    assert.equal(first, 'Contents');
    assert.match(second, /^ {4}Walls$/, JSON.stringify(second));
  });

  it('a tab inside a line moves to the next tab stop, and a run of spaces stays a run', () => {
    // One unit per character: stops every TAB_SIZE characters, as CSS tab-size draws them in the preview.
    assert.deepEqual(wrapText('ab\tc', 100, 10, false, perChar), [`ab${' '.repeat(TAB_SIZE - 2)}c`]);
    assert.deepEqual(wrapText('A  B', 100, 10, false, perChar), ['A  B']);
    assert.deepEqual(wrapText('Level:\t3', 100, 10, false, perChar), ['Level:  3']);
  });

  it('whitespace at a wrap point is dropped, never carried to the next line', () => {
    assert.deepEqual(wrapText('one  two', 5, 10, false, perChar), ['one', 'two']);
    assert.deepEqual(wrapText('one two three four', 40, 10, false, estimateTextWidth), ['one two', 'three', 'four']);
    assert.deepEqual(wrapText('a\r\nb', 100, 10, false, perChar), ['a', 'b'], 'a Windows line break from an imported template');
  });

  it('a tab after a wrap measures from the start of the line it lands on, as the preview does', () => {
    // "f" starts the second line, so the tab runs from column 1 to the stop at 4.
    assert.deepEqual(wrapText('abcde f\tX', 6, 10, false, perChar), ['abcde', 'f   X']);
    // A tab at the wrap point hangs at the end of the line, like any whitespace there.
    assert.deepEqual(wrapText('abcde\tX', 6, 10, false, perChar), ['abcde', 'X']);
  });

  it('a wide run of spaces or tabs never pushes a printed line past the column', () => {
    const text = `Name${' '.repeat(30)}Value\n\t\t\t\t\t\t\tDeep\nA\t\t\t\t\tB`;
    const lines = wrapText(text, 12, 10, false, perChar);
    for (const line of lines) assert.ok(line.length <= 12, JSON.stringify(lines));
    assert.deepEqual(lines, ['Name', 'Value', 'Deep', 'A', 'B']);
  });
});

describe('tabFill', () => {
  it('fills to the next stop in the line\'s own measure', () => {
    assert.equal(tabFill('', perChar), ' '.repeat(TAB_SIZE));
    assert.equal(tabFill('ab', perChar), ' '.repeat(TAB_SIZE - 2));
    assert.equal(tabFill('abcd', perChar), ' '.repeat(TAB_SIZE), 'a stop already reached is passed');
  });
});

describe('tabEdit (the text box\'s Tab and Shift+Tab)', () => {
  it('Tab at a caret, or over a selection inside one line, types a tab', () => {
    assert.deepEqual(tabEdit('ab', 1, 1, false), { text: 'a\tb', selectionStart: 2, selectionEnd: 2 });
    assert.deepEqual(tabEdit('abc', 1, 2, false), { text: 'a\tc', selectionStart: 2, selectionEnd: 2 });
  });

  it('Tab over several lines indents each of them and keeps them selected', () => {
    assert.deepEqual(tabEdit('a\nb\nc', 0, 3, false), { text: '\ta\n\tb\nc', selectionStart: 1, selectionEnd: 5 });
    // A selection ending just after a line break does not reach into the next line.
    assert.deepEqual(tabEdit('a\nb\nc', 0, 4, false), { text: '\ta\n\tb\nc', selectionStart: 1, selectionEnd: 6 });
  });

  it('Shift+Tab takes one indent off each touched line: a tab, or up to four spaces', () => {
    assert.deepEqual(tabEdit('x\n\tab', 4, 4, true), { text: 'x\nab', selectionStart: 3, selectionEnd: 3 });
    assert.deepEqual(tabEdit('      a\n\tb', 0, 10, true), { text: '  a\nb', selectionStart: 0, selectionEnd: 5 });
    assert.deepEqual(tabEdit('\na', 0, 0, true), null, 'the first, empty line has nothing to outdent');
    assert.equal(tabEdit('plain', 3, 3, true), null);
    // An end inside the last line's removed indent moves to that line's new start, so the
    // selection still spans both lines (and a following Tab indents both, not replaces "a").
    assert.deepEqual(tabEdit('  a\n  b', 0, 5, true), { text: 'a\nb', selectionStart: 0, selectionEnd: 2 });
  });
});
