/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition } from '@ifc-lite/lists';
import { columnToAutoColor } from './columnToAutoColor.js';

function col(partial: Partial<ColumnDefinition> & Pick<ColumnDefinition, 'source' | 'propertyName'>): ColumnDefinition {
  return { id: 'c1', ...partial };
}

describe('columnToAutoColor', () => {
  it('maps an ordinary attribute column straight through', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'attribute', propertyName: 'Name' })),
      { source: 'attribute', propertyName: 'Name' },
    );
  });

  it('routes the "Class" attribute column to ifcType (dedicated fast path)', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'attribute', propertyName: 'Class' })),
      { source: 'ifcType' },
    );
  });

  it('maps a property column with its pset/property name', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' })),
      { source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' },
    );
  });

  it('maps a quantity column with its qset/quantity name', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' })),
      { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
    );
  });

  /**
   * Regression for a coverage gap that hid a live bug: `columnToAutoColor`
   * had no case for `source: 'material'`, so it fell through to the
   * `default: return { source: 'ifcType' }` branch. Clicking "Color by this
   * column" on a Material list column silently colored the 3D view by IFC
   * type instead of by material — no error, just the wrong grouping. Proven
   * against unmodified `columnToAutoColor.ts` by direct invocation before
   * this test existed: `columnToAutoColor({ source: 'material', ... })`
   * returned `{ source: 'ifcType' }`.
   */
  it('preserves the material source rather than silently degrading to ifcType', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'material', propertyName: 'Material' })),
      { source: 'material' },
    );
  });

  /**
   * Same gap, classification column. AutoColorSpec.psetName doubles as a
   * classification-system filter (see engine.ts `selectClassificationRef`),
   * so it must be carried through, not dropped.
   */
  it('preserves the classification source and its system filter', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'classification', psetName: 'Uniclass', propertyName: 'System' })),
      { source: 'classification', psetName: 'Uniclass' },
    );
  });

  /** Same gap, model column — AutoColorSpec supports `source: 'model'` directly. */
  it('preserves the model source rather than silently degrading to ifcType', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'model', propertyName: 'Model' })),
      { source: 'model' },
    );
  });

  it('falls back to ifcType for spatial and zone columns (no AutoColorSpec equivalent)', () => {
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'spatial', propertyName: 'Storey' })),
      { source: 'ifcType' },
    );
    assert.deepStrictEqual(
      columnToAutoColor(col({ source: 'zone', propertyName: 'Zone' })),
      { source: 'ifcType' },
    );
  });
});
