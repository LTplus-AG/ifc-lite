/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_TITLE_BLOCK_FIELDS, TITLE_BLOCK_PRESETS, type TitleBlockConfig } from '@ifc-lite/drawing-2d';
import { restoreSheet } from '../store/slices/sheetSlice.validation.js';
import { createDefaultSheet } from '../store/slices/sheetSlice.js';
import { titleBlockWithEffectiveScale } from './titleBlockScaleField.js';

const scaleValue = (tb: TitleBlockConfig) => tb.fields.find((f) => f.id === 'scale')?.value;

function blockSaying(value: string): TitleBlockConfig {
  return {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => (f.id === 'scale' ? { ...f, value } : { ...f })),
    logo: null,
  } as TitleBlockConfig;
}

describe('titleBlockWithEffectiveScale', () => {
  it('prints the scale the drawing was placed at when the stored text disagrees and nothing was clamped', () => {
    // scale.factor 50 => 20 mm/m, not clamped; the stored field still says 1:100.
    assert.equal(scaleValue(titleBlockWithEffectiveScale(blockSaying('1:100'), 50, 20)), '1:50');
  });

  it('a sheet restored with scale 1:50 and the default 1:100 field text exports as 1:50', () => {
    const d = createDefaultSheet();
    const restored = restoreSheet({ ...d, scale: { name: '1:50', factor: 50, useCase: 'x' } });
    assert.ok(restored);
    assert.equal(scaleValue(restored.titleBlock), '1:100'); // the stale copy
    assert.equal(scaleValue(titleBlockWithEffectiveScale(restored.titleBlock, restored.scale.factor, 1000 / 50)), '1:50');
  });

  it('still reports a clamped scale and returns the same object when already right', () => {
    assert.equal(scaleValue(titleBlockWithEffectiveScale(blockSaying('1:100'), 100, 1000 / 126.58)), '1:126.58');
    const ok = blockSaying('1:100');
    assert.equal(titleBlockWithEffectiveScale(ok, 100, 10), ok);
  });

  it('leaves a scale field alone when auto-populate is off (#11458)', () => {
    const tb = {
      ...blockSaying('x'),
      fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => (f.id === 'scale'
        ? { ...f, autoPopulate: false, autoPopulateSource: 'drawing.scale', value: 'As indicated' }
        : { ...f })),
    } as TitleBlockConfig;
    assert.equal(scaleValue(titleBlockWithEffectiveScale(tb, 100, 10)), 'As indicated');
    assert.equal(titleBlockWithEffectiveScale(tb, 100, 10), tb);
  });
});
