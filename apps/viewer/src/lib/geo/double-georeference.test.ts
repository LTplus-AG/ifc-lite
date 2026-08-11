/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

import { detectDoubleGeoreference, identityConversionFields } from './double-georeference.js';

/**
 * Build a CoordinateInfo whose model centre lands on the given IFC world
 * position (Z-up metres). `computeModelCenterInIfcMeters` reads
 * `shiftedBounds` + `originShift` + `wasmRtcOffset` and maps viewer Y-up back
 * to IFC Z-up as `ifcX = worldX`, `ifcY = -worldZ`. Putting the whole position
 * in `originShift` with zero-extent bounds keeps that inversion trivial and
 * keeps these tests about the detector, not about the axis swap (which
 * reproject.test.ts already pins).
 */
function coordInfoAt(ifcX: number, ifcY: number, halfExtent = 0): CoordinateInfo {
  const originShift = { x: ifcX, y: 0, z: -ifcY };
  const shiftedBounds = {
    min: { x: -halfExtent, y: 0, z: -halfExtent },
    max: { x: halfExtent, y: 0, z: halfExtent },
  };
  return {
    originShift,
    shiftedBounds,
    // The producer's invariant: shiftedBounds = originalBounds - originShift.
    originalBounds: {
      min: {
        x: shiftedBounds.min.x + originShift.x,
        y: shiftedBounds.min.y + originShift.y,
        z: shiftedBounds.min.z + originShift.z,
      },
      max: {
        x: shiftedBounds.max.x + originShift.x,
        y: shiftedBounds.max.y + originShift.y,
        z: shiftedBounds.max.z + originShift.z,
      },
    },
    hasLargeCoordinates: true,
  };
}

/** The reporter's file (#2526): Vectorworks, EPSG:25833, mm project, m MapUnit. */
const ISSUE_2526_CONVERSION: MapConversion = {
  id: 73,
  sourceCRS: 41,
  targetCRS: 71,
  eastings: 311988.181,
  northings: 5996148.565,
  orthogonalHeight: 0,
  xAxisAbscissa: 0,
  xAxisOrdinate: 1,
  scale: undefined,
};

const METRE_CRS: Pick<ProjectedCRS, 'mapUnitScale'> = { mapUnitScale: 1 };

describe('detectDoubleGeoreference', () => {
  it('flags the issue #2526 file and reports the real displacement', () => {
    const found = detectDoubleGeoreference(
      ISSUE_2526_CONVERSION,
      METRE_CRS,
      // Site placement #49 = (311988180.54, 5996148564.99) mm.
      coordInfoAt(311988.18054, 5996148.56499),
      0.001,
    );
    assert.ok(found, 'expected a double georeference report');
    assert.ok(found!.residual < 1, `residual should be sub-metre, got ${found!.residual}`);
    // The file's 90° rotation swings the (map-sized) world centre too, so the
    // error is NOT simply ‖offset‖: the model goes from (X, Y) to (E - Y, N + X),
    // i.e. hypot(E - Y - X, N + X - Y) ≈ 6 004 km in projected metres. (The
    // 5 206 km quoted in the issue is the geodesic distance measured after the
    // inverse projection — a different, smaller quantity.)
    assert.ok(
      Math.abs(found!.displacement - 6_004_000) < 10_000,
      `expected ≈6 004 km of displacement, got ${found!.displacement}`,
    );
  });

  it('does NOT flag a correctly authored local-frame model', () => {
    // Geometry near the IFC origin, conversion carries the real site offset.
    assert.strictEqual(
      detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, coordInfoAt(12, -30), 0.001),
      null,
    );
  });

  it('does NOT flag a correctly authored absolute-coordinate model (LoGeoRef 20)', () => {
    // Geometry at map coordinates, conversion is already the identity — the
    // world centre is map-sized but does not coincide with a 0/0 offset.
    const identity: MapConversion = {
      ...ISSUE_2526_CONVERSION,
      eastings: 0,
      northings: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
    };
    assert.strictEqual(
      detectDoubleGeoreference(identity, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });

  it('does NOT flag a map-sized model whose offset is an unrelated location', () => {
    // Same CRS, but the conversion points 400 km away: not a duplication.
    const elsewhere: MapConversion = { ...ISSUE_2526_CONVERSION, northings: 5596148.565 };
    assert.strictEqual(
      detectDoubleGeoreference(elsewhere, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });

  it('tolerates a large-extent site (centre offset from the placement origin)', () => {
    // A 3 km-wide site puts its centre ~1.5 km from the site origin; the
    // relative tolerance (0.1% of ‖offset‖ ≈ 6 km here) must still catch it.
    const found = detectDoubleGeoreference(
      ISSUE_2526_CONVERSION,
      METRE_CRS,
      coordInfoAt(311988 + 1500, 5996149 + 1500),
      0.001,
    );
    assert.ok(found, 'expected the duplication to be caught despite the site extent');
  });

  it('scales millimetre MapConversion offsets before comparing', () => {
    // Same duplication expressed with a MILLIMETRE MapUnit: the offsets are
    // 1000× larger and only match the world centre after mapUnitScale.
    const mmConversion: MapConversion = {
      ...ISSUE_2526_CONVERSION,
      eastings: 311988180.54,
      northings: 5996148564.99,
    };
    const found = detectDoubleGeoreference(
      mmConversion,
      { mapUnitScale: 0.001 },
      coordInfoAt(311988.18054, 5996148.56499),
      0.001,
    );
    assert.ok(found, 'expected the mm-unit duplication to be caught');
    assert.ok(found!.residual < 1);
  });

  it('returns null without a conversion or without coordinate info', () => {
    assert.strictEqual(
      detectDoubleGeoreference(undefined, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
    assert.strictEqual(
      detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, undefined, 0.001),
      null,
    );
  });

  it('returns null for a non-finite offset rather than reporting NaN', () => {
    const broken: MapConversion = { ...ISSUE_2526_CONVERSION, eastings: NaN };
    assert.strictEqual(
      detectDoubleGeoreference(broken, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });
});

describe('identityConversionFields', () => {
  it('zeroes the horizontal offset and resets the axis, and touches nothing else', () => {
    const fields = identityConversionFields();
    assert.deepStrictEqual(
      Object.fromEntries(fields.map(f => [f.field, f.value])),
      { eastings: 0, northings: 0, xAxisAbscissa: 1, xAxisOrdinate: 0 },
    );
    // OrthogonalHeight and Scale must NOT be in the fix: the fingerprint is
    // horizontal, and zeroing a height that legitimately carries the site
    // altitude would trade one error for another.
    const names = fields.map(f => f.field);
    assert.ok(!names.includes('orthogonalHeight'));
    assert.ok(!names.includes('scale'));
  });

  it('makes the flagged model stop being flagged', () => {
    const fixed: MapConversion = {
      ...ISSUE_2526_CONVERSION,
      ...Object.fromEntries(identityConversionFields().map(f => [f.field, f.value])),
    };
    assert.strictEqual(
      detectDoubleGeoreference(
        fixed,
        METRE_CRS,
        coordInfoAt(311988.18054, 5996148.56499),
        0.001,
      ),
      null,
    );
  });
});
