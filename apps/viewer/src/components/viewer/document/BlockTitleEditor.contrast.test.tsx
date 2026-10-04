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
    assert.equal(warning(block), null);
    cleanup();
    assert.ok(warning({ ...block, scale: 0.5 } as BlockTitle), 'the 50% block warns');
  });
  it('stays silent for the default heading and for a background with automatic ink', () => {
    assert.equal(warning({ title: 'Doors' }), null);
    assert.equal(warning({ title: 'Doors', titleBackgroundColor: '#ffff00' }), null);
    assert.equal(warning({ title: 'Doors', titleTextColor: '#000000', titleBackgroundColor: '#ffff00' }), null);
  });
});
