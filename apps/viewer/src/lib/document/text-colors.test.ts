/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, estimateTextWidth } from './compose.js';
import { DOCUMENT_VERSION, validateDocumentSpec, type TextBlock } from './types.js';
import { parseDocumentFile } from './persistence.js';
import { REPORT_MARGIN } from '../export/report/compose.js';

const text: TextBlock = { kind: 'text', id: 'rgb', style: 'body', text: 'Colour', textColor: '#1264C8', backgroundColor: '#F1c35a' };
const document = { version: DOCUMENT_VERSION, id: 'doc', name: 'Colours', page: { size: 'A4', orientation: 'portrait' } as const, blocks: [text] };
const compose = (blocks: TextBlock[]) => composeDocument({ ...document, blocks, generatedAt: '', measure: estimateTextWidth });

describe('Text RGB invariants (#6492)', () => {
  it('accepts mixed-case RGB; imported unsafe/non-RGB colours are refused with their field path', () => {
    assert.deepEqual(validateDocumentSpec(document), []);
    for (const key of ['textColor', 'backgroundColor']) {
      for (const invalid of [null, 3, '', '#fff', '#12345678', 'red', 'rgb(1,2,3)', '#123456"/><script/>', '#zzzzzz']) {
        const raw = { ...document, blocks: [{ ...text, [key]: invalid }] };
        assert.ok(validateDocumentSpec(raw).some((error) => error.path === `blocks[0].${key}`));
        assert.throws(() => parseDocumentFile(JSON.stringify(raw)), new RegExp(`blocks\\[0\\]\\.${key}`));
      }
    }
    assert.deepEqual(validateDocumentSpec({ ...document, blocks: [{ ...text, textColor: undefined, backgroundColor: undefined }] }), [], 'existing templates keep their defaults');
  });

  it('paints coloured text through every page without entering margins or covering ink', () => {
    const layout = compose([{ ...text, text: Array.from({ length: 200 }, (_, index) => `Line ${index}`).join('\n') }]);
    assert.ok(layout.pages.length > 2);
    const lines: string[] = [];
    for (const page of layout.pages) {
      for (let i = 0; i < page.items.length; i += 2) {
        const fill = page.items[i];
        const ink = page.items[i + 1];
        assert.ok(fill.kind === 'text-background' && ink.kind === 'text');
        assert.equal(fill.color, '#F1c35a');
        assert.equal(ink.color, '#1264C8');
        assert.equal(fill.x, REPORT_MARGIN);
        assert.equal(fill.w, layout.size.w - 2 * REPORT_MARGIN);
        assert.ok(fill.y >= REPORT_MARGIN + 30);
        assert.ok(fill.y + fill.h <= layout.size.h - REPORT_MARGIN - 24);
        assert.ok(ink.y > fill.y && ink.y < fill.y + fill.h);
        lines.push(ink.text);
      }
    }
    assert.equal(lines.length, 200, 'no lines disappear at page boundaries');
    assert.equal(lines.at(-1), 'Line 199');
  });

  it('blank coloured blocks retain a background, and an unpaired half uses full width', () => {
    const layout = compose([{ ...text, text: '', width: 'half' }]);
    const fill = layout.pages[0].items[0];
    assert.ok(fill.kind === 'text-background');
    assert.equal(fill.w, layout.size.w - 2 * REPORT_MARGIN);
    assert.ok(fill.h > 0);
  });
});
