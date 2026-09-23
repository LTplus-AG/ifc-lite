/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The northing/easting transposition check (mapping spec §2.2, §9.1).
 *
 * Three properties, each of which the obvious implementation gets wrong:
 *
 * 1. It fires on a transposed pair. That is the point.
 * 2. It does NOT fire on data that is merely outside the zone. A bare
 *    "is this in range" test flags every out-of-zone dataset, which is a
 *    different problem and one this check cannot diagnose. The discriminating
 *    condition is *implausible as written AND plausible swapped*.
 * 3. It warns; it never refuses and never corrects. §9.1 is explicit that a
 *    plausibility argument must not become a gate, and that silently moving a
 *    correct dataset is the same failure in the other direction.
 */

import { describe, it, expect } from 'vitest';
import {
  TRANSVERSE_MERCATOR_BOUNDS, checkCoordinateOrder, type CrsPlausibilityBounds,
} from './coordinate-plausibility.js';
import { landXmlToIfc } from './landxml-to-ifc.js';
import type { LandXmlIfcSource } from './source-types.js';

const BOUNDS: CrsPlausibilityBounds = TRANSVERSE_MERCATOR_BOUNDS;

/** SWEREF99 TM, written correctly: easting ~1.6e5, northing ~6.4e6. */
const CORRECT: readonly [number, number] = [157899.16, 6406977.86];
/** The same point from a producer that wrote its LandXML point text easting-first. */
const TRANSPOSED: readonly [number, number] = [6406977.86, 157899.16];

describe('checkCoordinateOrder (§2.2, §9.1)', () => {
  it('says nothing about coordinates that are plausible as written', () => {
    expect(checkCoordinateOrder([CORRECT], BOUNDS, 'SWEREF99 TM')).toBeNull();
  });

  it('flags a transposed pair, naming both values and the violated bound', () => {
    const warning = checkCoordinateOrder([TRANSPOSED], BOUNDS, 'SWEREF99 TM');
    expect(warning).not.toBeNull();
    expect(warning!.code).toBe('LXIFC-COORD-ORDER');
    // A warning the operator cannot act on is noise: it must carry the
    // offending value, the bound it broke, and the CRS it was tested against.
    expect(warning!.message).toContain('6406977.86');
    expect(warning!.message).toContain('157899.16');
    expect(warning!.message).toContain('1000000');
    expect(warning!.message).toContain('SWEREF99 TM');
  });

  it('stays silent on data that is out of zone in BOTH orientations', () => {
    // Easting 12e6 is outside [0, 1e6]; swapping gives northing 12e6, outside
    // [0, 1e7]. Neither reading is plausible, so the evidence supports no
    // claim about the order — and a check that fired here would flag every
    // out-of-zone dataset as transposed.
    expect(checkCoordinateOrder([[12_000_000, 50]], BOUNDS, 'SWEREF99 TM')).toBeNull();
  });

  it('stays silent on a plain out-of-range northing that swapping would not fix', () => {
    // Easting is fine; northing is above the hemisphere bound. Swapping makes
    // the easting 11e6 — worse, not better.
    expect(checkCoordinateOrder([[157899.16, 11_000_000]], BOUNDS, 'SWEREF99 TM')).toBeNull();
  });

  it('skips non-finite pairs without swallowing a later transposed one', () => {
    const warning = checkCoordinateOrder(
      [[Number.NaN, 0], [0, Number.POSITIVE_INFINITY], TRANSPOSED], BOUNDS, 'SWEREF99 TM',
    );
    expect(warning).not.toBeNull();
    expect(warning!.code).toBe('LXIFC-COORD-ORDER');
  });

  it('says nothing when there is nothing to test', () => {
    expect(checkCoordinateOrder([], BOUNDS, 'SWEREF99 TM')).toBeNull();
  });

  it('bounds the easting to one zone width and the northing to a hemisphere', () => {
    // The asymmetry IS the discriminating power of the test — it is a property
    // of the Transverse-Mercator family (500 km false easting, ±500 km zone),
    // not of any one EPSG code, which is why no EPSG table is needed.
    expect(TRANSVERSE_MERCATOR_BOUNDS.easting).toEqual([0, 1_000_000]);
    expect(TRANSVERSE_MERCATOR_BOUNDS.northing).toEqual([0, 10_000_000]);
  });
});

function transposedSource(): LandXmlIfcSource {
  return {
    schema: 'LandXML-1.2',
    version: '1.2',
    units: {
      linearUnit: 'metre', elevationUnit: 'metre',
      linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
    },
    surfaces: [],
    plan: {
      cogoPoints: [{
        sourceId: 'landxml:cgpoint:1',
        name: 'P1',
        code: null,
        description: null,
        // Authored northing-first per the LandXML grammar, but this producer
        // put its easting there — so `northing` here holds an easting value.
        point: { northing: CORRECT[0], easting: CORRECT[1], elevation: 20.77 },
      }],
    },
  };
}

describe('landXmlToIfc coordinate-order plausibility (§9.1)', () => {
  it('warns, and still exports, when the declared CRS makes the order look transposed', () => {
    const result = landXmlToIfc(transposedSource(), {
      timestampMs: 0,
      crs: { Name: 'SWEREF99 TM', Bounds: BOUNDS },
    });
    // Warn-only is the decision, not an accident: §9.1 rejects refusing on a
    // plausibility argument. A future change to refuse here fails this test.
    expect(result.status).toBe('exported');
    expect(result.warnings.map((warning) => warning.code)).toContain('LXIFC-COORD-ORDER');
  });

  it('does not correct the coordinates it warns about', () => {
    const result = landXmlToIfc(transposedSource(), {
      timestampMs: 0,
      crs: { Name: 'SWEREF99 TM', Bounds: BOUNDS },
    });
    expect(result.status).toBe('exported');
    // The authored values are written through unchanged. Auto-correcting would
    // silently move a dataset that might have been right all along.
    const content = result.status === 'exported' ? result.content : '';
    expect(content).toContain('IFCCARTESIANPOINT((6406977.86,157899.16,20.77))');
  });

  it('runs no check, and raises no order warning, when the CRS declares no bounds', () => {
    const result = landXmlToIfc(transposedSource(), {
      timestampMs: 0,
      crs: { Name: 'SWEREF99 TM' },
    });
    expect(result.status).toBe('exported');
    // Never infer the order from magnitude alone — §2.2's closing line.
    expect(result.warnings.map((warning) => warning.code)).not.toContain('LXIFC-COORD-ORDER');
  });

  it('runs no check when no CRS is declared at all', () => {
    const result = landXmlToIfc(transposedSource(), { timestampMs: 0 });
    expect(result.status).toBe('exported');
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).not.toContain('LXIFC-COORD-ORDER');
    expect(codes).toContain('LXIFC-NO-CRS');
  });
});
