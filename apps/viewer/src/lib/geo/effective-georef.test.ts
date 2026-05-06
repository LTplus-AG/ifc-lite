/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { getEffectiveHorizontalScale, inferMapUnitScale, mergeMapConversion, mergeProjectedCRS } from './effective-georef.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

describe('effective georeferencing', () => {
  it('recomputes map unit scale when the edited MapUnit changes', () => {
    const original: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };

    const merged = mergeProjectedCRS(original, { mapUnit: 'US SURVEY FOOT' }, 1);

    assert.strictEqual(merged?.mapUnit, 'US SURVEY FOOT');
    assert.strictEqual(merged?.mapUnitScale, 0.3048006096);
  });

  it('preserves the extracted map unit scale when MapUnit was not edited', () => {
    const original: ProjectedCRS = {
      id: 1,
      name: 'EPSG:1234',
      mapUnit: 'CUSTOM',
      mapUnitScale: 2.5,
    };

    const merged = mergeProjectedCRS(original, { description: 'Edited CRS' }, 1);

    assert.strictEqual(merged?.description, 'Edited CRS');
    assert.strictEqual(merged?.mapUnitScale, 2.5);
  });

  it('overlays edited IfcMapConversion fields without dropping original rotation and scale', () => {
    const original: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 11,
      eastings: 100,
      northings: 200,
      orthogonalHeight: 5,
      xAxisAbscissa: 0,
      xAxisOrdinate: 1,
      scale: 0.9999,
    };

    const merged = mergeMapConversion(original, { eastings: 150, orthogonalHeight: 9 });

    assert.deepStrictEqual(merged, {
      id: 2,
      sourceCRS: 10,
      targetCRS: 11,
      eastings: 150,
      northings: 200,
      orthogonalHeight: 9,
      xAxisAbscissa: 0,
      xAxisOrdinate: 1,
      scale: 0.9999,
    });
  });

  it('infers common IFC map unit names', () => {
    assert.strictEqual(inferMapUnitScale('FOOT'), 0.3048);
    assert.strictEqual(inferMapUnitScale('METRE'), 1);
    assert.strictEqual(inferMapUnitScale('MILLIMETRE'), 0.001);
  });

  describe('getEffectiveHorizontalScale (issue #595)', () => {
    it('returns 1 when project mm and map m, with Scale=0.001 (Bonsai-style)', () => {
      // mm project (lengthUnitScale=0.001), m map (mapUnitScale=1), Scale=0.001
      assert.strictEqual(getEffectiveHorizontalScale(0.001, 1, 0.001), 1);
    });

    it('returns 1 when project m and map m, with Scale=1', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 1, 1), 1);
    });

    it('returns 1 when project ft and map m, with Scale=0.3048', () => {
      assert.strictEqual(getEffectiveHorizontalScale(0.3048, 1, 0.3048), 1);
    });

    it('returns 1 when project mm and map mm, with Scale=1 (consistent units)', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 0.001, 0.001), 1);
    });

    it('preserves a deliberate non-unit scaling (Scale=2 with metres throughout)', () => {
      assert.strictEqual(getEffectiveHorizontalScale(2, 1, 1), 2);
    });

    it('defaults Scale to 1 when undefined', () => {
      // Project mm, map m, Scale undefined (treated as 1):
      //   effective = 1 * 1 / 0.001 = 1000 → model would appear 1000x too large.
      // This matches the IFC spec; users who omit Scale in such files have an
      // inconsistent file. Issue #595 reports that this happens to "work"
      // because the workaround offsets a different bug — fixed here.
      assert.strictEqual(getEffectiveHorizontalScale(undefined, 1, 0.001), 1000);
    });

    it('falls back to 1 for non-positive lengthUnitScale or mapUnitScale', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 0, 1), 1);
      assert.strictEqual(getEffectiveHorizontalScale(1, 1, 0), 1);
      assert.strictEqual(getEffectiveHorizontalScale(1, -1, 1), 1);
    });
  });
});
