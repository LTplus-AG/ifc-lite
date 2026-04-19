/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pinning tests for the section cap styling primitives. The actual cap is
 * drawn by `Section2DOverlayRenderer` using the ids and defaults defined in
 * `section-cap-style.ts`; these tests guard the id contract the 2D-overlay
 * fill shader relies on, and sanity-check the default style values the
 * renderer loads when no user preference is stored.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_CAP_STYLE,
  HATCH_PATTERN_IDS,
  type HatchPatternId,
  type SectionCapStyle,
} from './section-cap-style.ts';

describe('HATCH_PATTERN_IDS', () => {
  it('assigns a unique non-negative integer id to every pattern', () => {
    const ids = Object.values(HATCH_PATTERN_IDS);
    for (const id of ids) {
      assert.ok(Number.isInteger(id), `pattern id ${id} should be integer`);
      assert.ok(id >= 0, `pattern id ${id} should be non-negative`);
    }
    assert.strictEqual(new Set(ids).size, ids.length, 'pattern ids must be unique');
  });

  it('matches the numeric branches the 2D-overlay fill shader uses', () => {
    // Changing any of these requires updating the corresponding
    // `patternId == Nu` branches in Section2DOverlayRenderer's fill shader.
    assert.strictEqual(HATCH_PATTERN_IDS.solid,      0);
    assert.strictEqual(HATCH_PATTERN_IDS.diagonal,   1);
    assert.strictEqual(HATCH_PATTERN_IDS.crossHatch, 2);
    assert.strictEqual(HATCH_PATTERN_IDS.horizontal, 3);
    assert.strictEqual(HATCH_PATTERN_IDS.vertical,   4);
    assert.strictEqual(HATCH_PATTERN_IDS.concrete,   5);
    assert.strictEqual(HATCH_PATTERN_IDS.brick,      6);
    assert.strictEqual(HATCH_PATTERN_IDS.insulation, 7);
  });
});

describe('DEFAULT_CAP_STYLE', () => {
  it('is a valid opaque diagonal hatch', () => {
    assert.strictEqual(DEFAULT_CAP_STYLE.pattern, 'diagonal');
    assert.strictEqual(DEFAULT_CAP_STYLE.fillColor.length,   4);
    assert.strictEqual(DEFAULT_CAP_STYLE.strokeColor.length, 4);
    for (const c of [...DEFAULT_CAP_STYLE.fillColor, ...DEFAULT_CAP_STYLE.strokeColor]) {
      assert.ok(c >= 0 && c <= 1, `channel ${c} must be in [0,1]`);
    }
    assert.ok(DEFAULT_CAP_STYLE.spacingPx >= 2, 'spacing must clear the shader clamp');
    assert.ok(DEFAULT_CAP_STYLE.widthPx   >= 1, 'width must clear the shader clamp');
  });

  it('lists a pattern that is a valid HatchPatternId', () => {
    const allIds: HatchPatternId[] = [
      'solid', 'diagonal', 'crossHatch', 'horizontal',
      'vertical', 'concrete', 'brick', 'insulation',
    ];
    assert.ok(allIds.includes(DEFAULT_CAP_STYLE.pattern));
  });

  it('shape is structurally assignable to SectionCapStyle', () => {
    // Purely a compile-time contract guard. If the shape drifts,
    // this assignment fails to compile, surfacing the break in CI.
    const _s: SectionCapStyle = DEFAULT_CAP_STYLE;
    assert.ok(_s);
  });
});
