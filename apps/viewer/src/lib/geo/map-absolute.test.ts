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

import { NORMAL_COORD_THRESHOLD_M, type CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion } from '@ifc-lite/parser';

import { computeModelCenterInIfcMeters, effectiveMapConversionForGeometry, isMapAbsoluteGeometry, matchMapAbsoluteGeometry } from './map-absolute.js';
import { getEffectiveAxisScales, getEffectiveHorizontalScale } from './geo-scale.js';

/**
 * Model geometry centred `offsetE` metres east of the declared anchor
 * (ifcX == anchorE + offsetE, ifcY == anchorN).
 */
function coordinateInfoNearAnchor(anchorE: number, anchorN: number, offsetE: number): CoordinateInfo {
  // ifcX = worldYupX = cx; ifcY = -worldYupZ = -cz  =>  cz = -ifcY.
  const cx = anchorE + offsetE;
  const bounds = { min: { x: cx, y: 0, z: -anchorN }, max: { x: cx, y: 0, z: -anchorN } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: true,
  };
}

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
    factorX: 2,
    factorY: 3,
    factorZ: 4,
    ...overrides,
  };
}

describe('computeModelCenterInIfcMeters frame conversion (#4799)', () => {
  it('normalises a zero viewer Z to positive-zero IFC northing', () => {
    const info = coordinateInfoAtAnchor(0, 0);
    const center = computeModelCenterInIfcMeters(info);
    assert.equal(Object.is(center.ifcY, 0), true);
  });

  it('keeps bounds-center + originShift + RTC evaluation order under cancellation', () => {
    const bounds = {
      min: { x: 1e16, y: 1e16, z: 1e16 },
      max: { x: 1e16, y: 1e16, z: 1e16 },
    };
    const center = computeModelCenterInIfcMeters({
      originShift: { x: -1e16, y: -1e16, z: -1e16 },
      originalBounds: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      },
      shiftedBounds: bounds,
      hasLargeCoordinates: true,
      wasmRtcOffset: { x: 1, y: -1, z: 1 },
    });
    assert.deepEqual(center, { ifcX: 1, ifcY: -1, ifcZ: 1 });
  });
});

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
    assert.deepStrictEqual(
      [effective.factorX, effective.factorY, effective.factorZ],
      [undefined, undefined, undefined],
      'already-absolute coordinates must not be rescaled by subtype factors',
    );
  });

  it('stays identity through the real axis-scale helper when project and map units differ (#4615)', () => {
    const conversion = makeConversion({ eastings: 312_007_000, northings: 5_996_161_000 });
    const mapUnitScale = 1;
    const lengthUnitScale = 0.001;
    const coordinateInfo = coordinateInfoAtAnchor(
      conversion.eastings * mapUnitScale,
      conversion.northings * mapUnitScale,
    );
    const effective = effectiveMapConversionForGeometry(conversion, mapUnitScale, coordinateInfo);
    assert.deepStrictEqual(
      getEffectiveAxisScales(effective, mapUnitScale, lengthUnitScale),
      { x: 1, y: 1, z: 1 },
    );
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

/**
 * The detection radius IS the RTC re-base threshold, not a second copy of its
 * value (#4611).
 *
 * The doc on `MAP_ABSOLUTE_MAX_CENTER_DISTANCE_METERS` says "matches the wasm
 * RTC re-base threshold (10 km)", and the reason it has to is causal: a
 * compliant file's geometry sits near the local origin BECAUSE the re-base put
 * it there, so this radius is the one distance at which "the model is drawn at
 * its anchor" and "the model was re-based away from its anchor" separate. It
 * was its own `10_000` literal, so moving the re-base threshold would have left
 * the radius behind.
 *
 * Both boundaries below are derived from the imported constant. Mutation: set
 * `NORMAL_COORD_THRESHOLD_M` to 40_000 in packages/geometry and, with the
 * literal back, "just inside" goes red — the detection still stops at 10 km
 * while a model re-based at 40 km is now the one it has to recognise.
 */
describe('effectiveMapConversionForGeometry — centre radius is the RTC threshold', () => {
  it('fires for a centre just inside the RTC re-base threshold of the anchor', () => {
    const conversion = makeConversion();
    const coordinateInfo = coordinateInfoNearAnchor(
      conversion.eastings,
      conversion.northings,
      NORMAL_COORD_THRESHOLD_M * 0.99,
    );
    const effective = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.strictEqual(effective.eastings, 0, 'a centre inside the threshold is the absolute-placement signature');
    assert.strictEqual(effective.scale, 1);
  });

  it('does not fire for a centre just outside the RTC re-base threshold', () => {
    const conversion = makeConversion();
    const coordinateInfo = coordinateInfoNearAnchor(
      conversion.eastings,
      conversion.northings,
      NORMAL_COORD_THRESHOLD_M * 1.01,
    );
    const effective = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.strictEqual(effective, conversion, 'a centre beyond the threshold is an ordinary offset model');
  });

  it('does not fire at exactly the threshold: the comparison is >=', () => {
    const conversion = makeConversion();
    const coordinateInfo = coordinateInfoNearAnchor(
      conversion.eastings,
      conversion.northings,
      NORMAL_COORD_THRESHOLD_M,
    );
    const effective = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.strictEqual(effective, conversion);
  });
});

describe('effectiveMapConversionForGeometry — site anchor in map units (#9480)', () => {
  // Vectorworks 2026 Update 7: IfcSite at (311988.18054, 5996148.56499) in a
  // millimetre file, i.e. 311.988 m / 5996.149 m, with the conversion
  // repeating the anchor in metres.
  const conversion = makeConversion({ eastings: 311988.181, northings: 5996148.565, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: undefined });
  const mm = (info: CoordinateInfo): CoordinateInfo => ({ ...info, lengthUnitScale: 0.001 });
  const siteE = 311988.18054 * 0.001;
  const siteN = 5996148.56499 * 0.001;

  it('moves the geometry by the anchor it does not carry, with no rotation or scale', () => {
    const effective = effectiveMapConversionForGeometry(conversion, 1, mm(coordinateInfoNearAnchor(siteE, siteN, 30)));
    assert.notStrictEqual(effective, conversion);
    assert.ok(Math.abs(effective.eastings - 311988.181 * 0.999) < 1e-6, `eastings ${effective.eastings}`);
    assert.ok(Math.abs(effective.northings - 5996148.565 * 0.999) < 1e-6, `northings ${effective.northings}`);
    assert.strictEqual(effective.xAxisAbscissa, 1);
    assert.strictEqual(effective.xAxisOrdinate, 0);
    assert.strictEqual(effective.scale, 1);
    // The site origin lands on the declared anchor.
    assert.ok(Math.abs(siteE + effective.eastings - 311988.181) < 1e-3);
    assert.ok(Math.abs(siteN + effective.northings - 5996148.565) < 1e-3);
    assert.deepEqual(
      matchMapAbsoluteGeometry(conversion, 1, mm(coordinateInfoNearAnchor(siteE, siteN, 30))),
      { kind: 'unitMismatchedAnchor', anchorUnitRatio: 0.001 },
    );
  });

  it('needs the project length unit to say the units differ', () => {
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, coordinateInfoNearAnchor(siteE, siteN, 30)), conversion);
  });

  it('does not fire when the file and map units agree', () => {
    const metres: CoordinateInfo = { ...coordinateInfoNearAnchor(siteE, siteN, 30), lengthUnitScale: 1 };
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, metres), conversion);
  });

  it('leaves a compliant millimetre model near its local origin alone', () => {
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, mm(coordinateInfoAtAnchor(20, -15))), conversion);
    assert.strictEqual(isMapAbsoluteGeometry(conversion, 1, mm(coordinateInfoAtAnchor(20, -15))), false);
  });

  it('takes a centre within a tenth of the mis-scaled anchor distance, not beyond', () => {
    const radius = 0.1 * Math.hypot(siteE, siteN);
    assert.notStrictEqual(effectiveMapConversionForGeometry(conversion, 1, mm(coordinateInfoNearAnchor(siteE, siteN, radius * 0.99))), conversion);
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, mm(coordinateInfoNearAnchor(siteE, siteN, radius * 1.01))), conversion);
  });

  it('keeps the #2526 reading when the site already sits at the anchor in project units', () => {
    const effective = effectiveMapConversionForGeometry(conversion, 1, mm(coordinateInfoAtAnchor(311988.18054, 5996148.56499)));
    assert.strictEqual(effective.eastings, 0);
    assert.strictEqual(effective.northings, 0);
  });
});

describe('effectiveMapConversionForGeometry — site height under the #9480 slip', () => {
  const conversion = makeConversion({ eastings: 311988.181, northings: 5996148.565, orthogonalHeight: 2, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: undefined });
  const siteE = 311988.18054 * 0.001;
  const siteN = 5996148.56499 * 0.001;
  const withSite = (site?: { x: number; y: number; z: number }): CoordinateInfo => ({
    ...coordinateInfoNearAnchor(siteE, siteN, 30), lengthUnitScale: 0.001, ...(site ? { siteOrigin: site } : {}),
  });

  it('raises OrthogonalHeight by the slipped part of the site Z', () => {
    const effective = effectiveMapConversionForGeometry(conversion, 1, withSite({ x: siteE, y: siteN, z: 0.014 }));
    // 14 mm read as metres: the site sits 14 m up, not 0.014 m.
    assert.ok(Math.abs(effective.orthogonalHeight - (2 + 0.014 * 999)) < 1e-9, `height ${effective.orthogonalHeight}`);
    assert.deepEqual(
      matchMapAbsoluteGeometry(conversion, 1, withSite({ x: siteE, y: siteN, z: 0.014 })),
      { kind: 'unitMismatchedAnchor', anchorUnitRatio: 0.001, siteHeightShiftMetres: 0.014 * 999 },
    );
  });

  it('expresses the shift in map units', () => {
    // A millimetre file in a foot CRS: the site Z 14 means 14 ft (4.267 m),
    // read as 0.014 m, so the shift is 0.014 x (304.8 - 1) m, in feet.
    const effective = effectiveMapConversionForGeometry(conversion, 0.3048, withSite({ x: siteE, y: siteN, z: 0.014 }));
    const ratio = 0.001 / 0.3048;
    assert.ok(Math.abs(effective.orthogonalHeight - (2 + 0.014 * (1 / ratio - 1) / 0.3048)) < 1e-9, `height ${effective.orthogonalHeight}`);
    assert.ok(Math.abs(2 * 0.3048 + 0.014 + (effective.orthogonalHeight - 2) * 0.3048 - (2 * 0.3048 + 14 * 0.3048)) < 1e-9);
  });

  it('leaves the height authored without a published site origin', () => {
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, withSite()).orthogonalHeight, 2);
  });

  it('leaves the height authored when the site is not the slipped anchor', () => {
    const elsewhere = { x: siteE + 1000, y: siteN, z: 0.014 };
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, withSite(elsewhere)).orthogonalHeight, 2);
  });

  it('never touches the #2526 height, site origin or not', () => {
    const info = { ...coordinateInfoAtAnchor(311988.18054, 5996148.56499), lengthUnitScale: 0.001, siteOrigin: { x: 311988.18054, y: 5996148.56499, z: 14 } };
    assert.strictEqual(effectiveMapConversionForGeometry(conversion, 1, info).orthogonalHeight, 2);
  });
});
