/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The title controls warn when the chosen title colour cannot be read on its background (#6705 F5). */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import type { BlockTitle } from '@/lib/document/block-title';
import { BlockTitleEditor } from './BlockTitleEditor.js';

const warning = (block: BlockTitle) => render(<BlockTitleEditor block={block} onChange={() => {}} />).querySelector('[data-block-title-contrast]');
/** The warning's text, or null: a failing assertion then prints a sentence, not a DOM node. */
const warningText = (block: BlockTitle) => warning(block)?.textContent ?? null;

describe('BlockTitleEditor contrast warning (#6705 F5)', () => {
  afterEach(cleanup);
  it('warns when the title colour equals its background, and says how far below the minimum it is', () => {
    const shown = warning({ title: 'Doors', titleTextColor: '#ffff00', titleBackgroundColor: '#ffff00' });
    assert.ok(shown, 'the warning is shown');
    assert.equal(shown.tagName, 'OUTPUT', 'announced as a status (an <output> has the implicit status role)');
    assert.match(shown.textContent ?? '', /1\.0:1/);
    assert.match(shown.textContent ?? '', /4\.5:1/);
  });
  it('never shows a failing ratio rounded up to the minimum it fails', () => {
    // #777777 on white is 4.48:1: below 4.5, so it must not read "4.5:1".
    const shown = warning({ title: 'Doors', titleTextColor: '#777777' });
    assert.ok(shown, 'the warning is shown');
    assert.match(shown.textContent ?? '', /\(4\.4:1/);
  });
  it('uses the stricter minimum for a large title on a block shrunk below 14pt', () => {
    // #949494 on white is 3.03:1: enough for a 14pt bold title, not for the 7pt it prints at in a 50% block.
    const block = { kind: 'text', id: 't', style: 'body', text: 'x', title: 'Doors', titleTextColor: '#949494', titleFontSize: 14 } as BlockTitle;
    assert.equal(warningText(block), null);
    cleanup();
    assert.ok(warning({ ...block, scale: 0.5 } as BlockTitle), 'the 50% block warns');
  });
  it('judges an unstyled chart title at the size its chart text prints it', () => {
    // #949494 on white is 3.03:1: enough for the 16.5pt title of 18pt chart text (unit 1.5), not for the 11pt one of 12pt text.
    const chart = { kind: 'chart', id: 'c', title: 'Doors', titleTextColor: '#949494' };
    assert.equal(warningText({ ...chart, fontSize: 18 } as BlockTitle), null);
    cleanup();
    assert.ok(warning({ ...chart, fontSize: 12 } as BlockTitle), 'the default chart text size warns');
  });
  it('stays silent for the default heading and for a background with automatic ink', () => {
    assert.equal(warningText({ title: 'Doors' }), null);
    assert.equal(warningText({ title: 'Doors', titleBackgroundColor: '#ffff00' }), null);
    assert.equal(warningText({ title: 'Doors', titleTextColor: '#000000', titleBackgroundColor: '#ffff00' }), null);
  });
});
