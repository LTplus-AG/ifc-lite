/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The last two #6705 follow-ups: a heading on a strip has its capitals centred in that strip (F7), and
 * a heading whose ink barely differs from what it is printed on is reported, never recoloured (F5).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TITLE_HEIGHT, blockTitleContrast } from './block-title.js';
import { blockTitleItems, TITLE_CAP_HEIGHT } from './compose-block-title.js';

const keep = (text: string) => text;

describe('a heading on a strip is centred in it (#6705 F7)', () => {
  for (const titleFontSize of [6, 8, 11, 14, 18, 24]) {
    for (const unit of [1, 1.5]) {
      it(`size ${titleFontSize}, chart text unit ${unit}: the capitals sit as far from the strip's top as from its bottom`, () => {
        const [strip, text] = blockTitleItems({ titleFontSize, titleBackgroundColor: '#ffff00' }, 'Heading', 40, 100, 300, keep, unit);
        assert.ok(strip.kind === 'rect' && text.kind === 'text');
        const above = text.y - TITLE_CAP_HEIGHT * text.size - strip.y;
        const below = strip.y + strip.h - text.y;
        assert.ok(Math.abs(above - below) < 1e-9, `${above} above the capitals, ${below} below the baseline`);
        assert.ok(above > 0, 'the capitals start inside the strip');
      });
    }
  }
  it('without a strip the baseline stays one size below the top, as every heading printed before', () => {
    for (const block of [{}, { titleFontSize: 6 }, { titleFontSize: 24, titleTextColor: '#123456' }]) {
      const items = blockTitleItems(block, 'Heading', 40, 100, 300, keep);
      assert.equal(items.length, 1);
      const [text] = items;
      assert.ok(text.kind === 'text');
      assert.equal(text.y, 100 + text.size);
    }
  });
  it('the default strip of an 11pt heading keeps its height', () => {
    const [strip] = blockTitleItems({ titleBackgroundColor: '#ffff00' }, 'Heading', 0, 0, 100, keep);
    assert.ok(strip.kind === 'rect');
    assert.equal(strip.h, BLOCK_TITLE_HEIGHT);
  });
});

describe('a heading that cannot be read is reported (#6705 F5)', () => {
  it('ink equal to its strip has contrast 1, below the minimum', () => {
    const { ratio, minimum } = blockTitleContrast({ titleTextColor: '#ffff00', titleBackgroundColor: '#ffff00' });
    assert.ok(Math.abs(ratio - 1) < 1e-9);
    assert.ok(ratio < minimum);
  });
  it('white ink without a strip is measured against white paper', () => {
    const { ratio, minimum } = blockTitleContrast({ titleTextColor: '#ffffff' });
    assert.ok(ratio < minimum);
  });
  it('the default ink, and the automatic ink on any strip, always pass', () => {
    for (const block of [{}, { titleBackgroundColor: '#ffff00' }, { titleBackgroundColor: '#1a1a1a' }, { titleBackgroundColor: '#808080' }]) {
      const { ratio, minimum } = blockTitleContrast(block);
      assert.ok(ratio >= minimum, `${JSON.stringify(block)}: ${ratio}`);
    }
  });
  it('the minimum follows the size the heading prints at, block size included', () => {
    assert.equal(blockTitleContrast({ titleFontSize: 14 }, 0.5).minimum, 4.5, 'a 14pt title at 50% prints at 7pt');
    assert.equal(blockTitleContrast({ titleFontSize: 11 }, 1.5).minimum, 3, 'an 11pt title at 150% prints at 16.5pt');
    assert.equal(blockTitleContrast({ titleFontSize: 14 }).minimum, 3);
    assert.equal(blockTitleContrast({}, 1, 1.5).minimum, 3, 'an unstyled chart title at text unit 1.5 prints at 16.5pt');
    assert.equal(blockTitleContrast({ titleFontSize: 11 }, 1, 1.5).minimum, 4.5, 'an authored size is not scaled by the chart unit');
  });
  it('large bold headings need 3:1, smaller ones 4.5:1 (WCAG AA)', () => {
    // #767676 on white is 4.54:1 and #949494 is 3.03:1.
    assert.equal(blockTitleContrast({ titleTextColor: '#949494' }).minimum, 4.5);
    assert.ok(blockTitleContrast({ titleTextColor: '#949494' }).ratio < 4.5);
    const large = blockTitleContrast({ titleTextColor: '#949494', titleFontSize: 14 });
    assert.equal(large.minimum, 3);
    assert.ok(large.ratio >= 3);
    assert.ok(blockTitleContrast({ titleTextColor: '#767676' }).ratio >= 4.5);
  });
});
