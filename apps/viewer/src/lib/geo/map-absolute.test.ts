/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deep review of #2534 (2026-08-10, louistrue) — minor finding on
 * `map-absolute.ts`: the guard zeroed eastings/northings and forced the
 * identity axis, but left `scale` authored. A non-unity `IfcMapConversion.
 * Scale` (a UTM point-scale factor like 0.9996, or any authored value) then
 * multiplied the model's FULL absolute coordinate instead of a small local
 * delta — moving the pin kilometres off for a file that would otherwise be
 * placed exactly right by this detection.
 *
 * These tests pin the exact scenario from the review (E ≈ 312 007,
 * N ≈ 5 996 161, Scale = 0.9996) and fail on a revert of the `scale: 1`
 * line in `effectiveMapConversionForGeometry`'s returned object.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion } from '@ifc-lite/parser';

import { effectiveMapConversionForGeometry } from './map-absolute.js';
import { getEffectiveHorizontalScale } from './geo-scale.js';

/** Model geometry centred exactly at the declared anchor (ifcX/ifcY == anchorE/anchorN). */
function coordinateInfoAtAnchor(anchorE: number, anchorN: number): CoordinateInfo {
  // ifcX = worldYupX = cx; ifcY = -worldYupZ = -cz  =>  cz = -ifcY.
  const bounds = { min: { x: anchorE, y: 0, z: -anchorN }, max: { x: anchorE, y: 0, z: -anchorN } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: true,
  };
}

function makeConversion(overrides: Partial<MapConversion> = {}): MapConversion {
  return {
    id: 1,
    sourceCRS: 1,
    targetCRS: 2,
    eastings: 312_007,
    northings: 5_996_161,
    orthogonalHeight: 0,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 0.9996,
    ...overrides,
  };
}

describe('effectiveMapConversionForGeometry — scale neutralisation', () => {
  it('neutralises Scale to 1 when the map-absolute signature fires', () => {
    const conversion = makeConversion();
    const coordinateInfo = coordinateInfoAtAnchor(conversion.eastings, conversion.northings);
    const effective = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.strictEqual(effective.eastings, 0);
    assert.strictEqual(effective.northings, 0);
    assert.strictEqual(effective.xAxisAbscissa, 1);
    assert.strictEqual(effective.xAxisOrdinate, 0);
    assert.strictEqual(effective.scale, 1, 'authored Scale=0.9996 must not survive into the neutralised conversion');
  });

  it('reproduces the review scenario: without the scale fix the pin would land ~2.4km south', () => {
    // Reviewer's failure scenario: metre-unit file (mus == lus == 1), authored
    // Scale = 0.9996 (a UTM point-scale factor). getEffectiveHorizontalScale
    // does NOT apply the unit-bridging heuristic here because mus == lus, so
    // an unfixed guard (Scale left authored) would compute
    // northing = 0.9996 * 5_996_161 = 5_993_763 (a ~2398m southward error).
    const conversion = makeConversion();
    const coordinateInfo = coordinateInfoAtAnchor(conversion.eastings, conversion.northings);
    const mapUnitScale = 1;
    const lengthUnitScale = 1;
    const effective = effectiveMapConversionForGeometry(conversion, mapUnitScale, coordinateInfo);

    // Downstream formula (reproject.ts's computeProjectedCenter):
    // N = northings*mapScale + hScale*(ordinate*ifcX + abscissa*ifcY)
    const hScale = getEffectiveHorizontalScale(effective.scale, mapUnitScale, lengthUnitScale);
    const ifcY = conversion.northings; // geometry centre coincides with the anchor
    const northing = effective.northings * mapUnitScale + hScale * (0 * 0 + 1 * ifcY);
    assert.strictEqual(hScale, 1, 'neutralised scale must yield an effective horizontal scale of exactly 1');
    assert.strictEqual(northing, conversion.northings, 'geometry\'s own absolute northing must pass through unchanged');

    // Sanity: prove the failure this fix prevents — the UNFIXED formula
    // (authored Scale kept) really would have landed ~2398 m south.
    const unfixedHScale = getEffectiveHorizontalScale(conversion.scale, mapUnitScale, lengthUnitScale);
    const unfixedNorthing = 0 * mapUnitScale + unfixedHScale * (0 * 0 + 1 * ifcY);
    assert.ok(
      Math.abs(unfixedNorthing - conversion.northings) > 2000,
      `expected the unfixed formula to diverge by >2km, got ${Math.abs(unfixedNorthing - conversion.northings)}`,
    );
  });

  it('does not fire (and scale stays authored) for a compliant file', () => {
    const conversion = makeConversion({ eastings: 5_000, northings: 3_000 }); // below MIN_ANCHOR_METERS
    const coordinateInfo: CoordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      hasLargeCoordinates: false,
    };
    const effective = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.strictEqual(effective, conversion, 'guard must not fire for a compliant small-offset file');
    assert.strictEqual(effective.scale, 0.9996, 'authored scale is untouched when the guard does not fire');
  });
});
