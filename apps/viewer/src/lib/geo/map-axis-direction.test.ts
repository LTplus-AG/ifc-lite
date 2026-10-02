/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6700: the canonical map-axis direction, its agreement with the neutral
 * spatial-reference boundary, the refusal of a vector that carries no
 * direction, the unit-axis no-regression numbers, and the authored vector
 * surviving every read path untouched.
 *
 * The end-to-end projection invariants live in
 * `map-axis-direction.projection.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localViewerToProjected, projectedToLocalViewer } from '@ifc-lite/geometry';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { computeCesiumModelOrigin, createCesiumBridge } from './cesium-bridge.js';
import { projectedDeltaToViewerDelta, viewerDeltaToProjectedDelta } from './cesium-placement.js';
import { detectDoubleGeoreference } from './double-georeference.js';
import { mergeMapConversion } from './effective-georef.js';
import { resolveKmzHeading } from './kmz-export.js';
import { spatialReferenceFromIfc } from './ifc-spatial-reference.js';
import { refusedAxisDelta, resolveMapAxisDirection } from './map-axis-direction.js';
import { computeFootprintGeoJSON, reprojectToLatLon } from './reproject.js';

const CRS: ProjectedCRS = { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 };

function box(ifcX: number, ifcY: number, ifcZ: number, half: number): CoordinateInfo {
  const min = { x: ifcX - half, y: ifcZ - half, z: -ifcY - half };
  const max = { x: ifcX + half, y: ifcZ + half, z: -ifcY + half };
  return {
    originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min, max }, shiftedBounds: { min, max }, hasLargeCoordinates: false,
  };
}

function conversion(over: Partial<MapConversion> = {}): MapConversion {
  return { id: 2, sourceCRS: 1, targetCRS: 1, eastings: 500_000, northings: 4_000_000, orthogonalHeight: 10, scale: 1, ...over };
}

/** Every vector class the refusal has to tell apart. */
const NO_DIRECTION: ReadonlyArray<readonly [string, number, number]> = [
  ['zero', 0, 0],
  ['negative zero', -0, -0],
  ['below the minimum length', 1e-13, 0],
  ['NaN abscissa', Number.NaN, 0],
  ['NaN ordinate', 1, Number.NaN],
  ['mixed NaN with a usable ordinate', Number.NaN, 0.6],
  ['Infinity', Number.POSITIVE_INFINITY, 0],
  ['-Infinity ordinate', 0, Number.NEGATIVE_INFINITY],
  ['hypot overflow of two finite components', Number.MAX_VALUE, Number.MAX_VALUE],
];

describe('resolveMapAxisDirection (#6700)', () => {
  it('returns the unit direction, independent of the vector length', () => {
    assert.deepEqual(resolveMapAxisDirection(1, 0), { a: 1, b: 0 });
    assert.deepEqual(resolveMapAxisDirection(2, 0), { a: 1, b: 0 });
    assert.deepEqual(resolveMapAxisDirection(0.5, 0), { a: 1, b: 0 });
    assert.deepEqual(resolveMapAxisDirection(0, -7), { a: 0, b: -1 });
    const d = resolveMapAxisDirection(3, 4);
    assert.ok(d, 'direction');
    assert.ok(Math.abs(d.a - 0.6) < 1e-15 && Math.abs(d.b - 0.8) < 1e-15, `got (${d.a}, ${d.b})`);
    assert.ok(Math.abs(Math.hypot(d.a, d.b) - 1) < 1e-15, 'unit length');
  });

  it('an absent component takes the IFC default, as every consumer did before', () => {
    assert.deepEqual(resolveMapAxisDirection(undefined, undefined), { a: 1, b: 0 });
    assert.deepEqual(resolveMapAxisDirection(2, undefined), { a: 1, b: 0 });
    assert.deepEqual(resolveMapAxisDirection(undefined, 3), resolveMapAxisDirection(1, 3));
  });

  for (const [label, a, b] of NO_DIRECTION) {
    it(`refuses a vector with no direction: ${label}`, () => {
      assert.equal(resolveMapAxisDirection(a, b), null);
    });
  }

  it('does not repair a mixed pair into a rotation the file never authored', () => {
    // (NaN, 0.6) once normalised against its one finite component and
    // produced a real ~31 degree rotation (#1965 review round 2).
    assert.equal(resolveMapAxisDirection(Number.NaN, 0.6), null);
  });
});

describe('the canonical direction agrees with the spatial-reference boundary (#6700)', () => {
  // `localViewerToProjected` lives in `@ifc-lite/geometry` and normalises with
  // its own private helper. Feeding both the same vectors, degenerate ones
  // included, is what stops the two homes from drifting apart.
  const make = (a: number, b: number) => spatialReferenceFromIfc({
    mapConversion: { id: 2, sourceCRS: 1, targetCRS: 1, eastings: 0, northings: 0, orthogonalHeight: 0, xAxisAbscissa: a, xAxisOrdinate: b, scale: 1 },
    projectedCRS: CRS, lengthUnitScale: 1,
  });

  const vectors: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [2, 0], [0.5, 0], [3, 4], [0.6, 0.8], [0, 1], [-5, 0], [1, -1], [1e-6, 0], [1e6, 1e6], [2e-12, 0],
    ...NO_DIRECTION.map(([, a, b]) => [a, b] as const),
  ];

  for (const [a, b] of vectors) {
    it(`axis (${a}, ${b}): same verdict and same cosine/sine`, () => {
      const direction = resolveMapAxisDirection(a, b);
      // A viewer-space +X unit step is IFC +X, so E = cos, N = sin.
      const projected = localViewerToProjected(make(a, b), [1, 0, 0]);
      if (direction === null) {
        assert.equal(projected, null, 'the boundary must refuse what the canonical function refuses');
        return;
      }
      assert.ok(projected, 'the boundary must accept what the canonical function accepts');
      assert.ok(Math.abs(projected[0] - direction.a) < 1e-12, `cosine ${projected[0]} vs ${direction.a}`);
      assert.ok(Math.abs(projected[1] - direction.b) < 1e-12, `sine ${projected[1]} vs ${direction.b}`);
      const back = projectedToLocalViewer(make(a, b), projected);
      assert.ok(back && Math.abs(back[0] - 1) < 1e-12, 'inverse agrees');
    });
  }
});

describe('a vector with no direction is refused by every consumer that can refuse (#6700)', () => {
  // Measured on `upstream/main` with this same loop: a NON-FINITE vector was
  // already refused (null) by the pin, the Cesium origin and the bridge, and
  // by the footprint; a ZERO-length vector was NOT refused, it silently placed
  // the pin at the raw Eastings/Northings with the model offset dropped. The
  // zero-length rows below are therefore a deliberate unification with the
  // spatial-reference boundary, which has always refused them.
  const info = box(1000, 2000, 30, 5);

  for (const [label, a, b] of NO_DIRECTION) {
    it(`${label}: no pin, no footprint, no Cesium origin, no bridge`, async () => {
      const conv = conversion({ xAxisAbscissa: a, xAxisOrdinate: b });
      assert.equal(await reprojectToLatLon(conv, CRS, info, 1), null, 'pin');
      assert.equal(await computeFootprintGeoJSON(conv, CRS, info, 1), null, 'footprint');
      assert.equal(await computeCesiumModelOrigin(conv, CRS, info, 1), null, 'origin');
      assert.equal(await createCesiumBridge(conv, CRS, info, 1), null, 'bridge');
    });
  }

  // The numeric delta helpers cannot return null. Measured on main: an exactly
  // zero vector gave a zero displacement and a NaN component gave NaN; both
  // are kept. (Infinite and sub-epsilon vectors used to give infinities and
  // vanishing values; they now follow the same rule as the zero case.)
  const DELTA_CASES: ReadonlyArray<readonly [string, number, number, number]> = [
    ['zero', 0, 0, 0],
    ['NaN abscissa', Number.NaN, 0, Number.NaN],
    ['NaN ordinate', 1, Number.NaN, Number.NaN],
    ['mixed NaN with a usable ordinate', Number.NaN, 0.6, Number.NaN],
  ];
  for (const [label, a, b, expected] of DELTA_CASES) {
    it(`${label}: the numeric delta helpers return ${expected} in both directions, as on main`, () => {
      const conv = conversion({ xAxisAbscissa: a, xAxisOrdinate: b });
      const fwd = viewerDeltaToProjectedDelta(40, -25, conv, CRS, 1);
      const inv = projectedDeltaToViewerDelta(40, -25, conv, CRS, 1);
      for (const value of [fwd.eastings, fwd.northings, inv.x, inv.z]) {
        assert.ok(Number.isNaN(expected) ? Number.isNaN(value) : value === expected, `got ${value}, expected ${expected}`);
      }
    });
  }

  it('refusedAxisDelta: 0 for a finite refused pair, NaN as soon as a component is non-finite', () => {
    assert.equal(refusedAxisDelta(0, 0), 0);
    assert.equal(refusedAxisDelta(1e-13, 0), 0);
    assert.ok(Number.isNaN(refusedAxisDelta(Number.NaN, 0)));
    assert.ok(Number.isNaN(refusedAxisDelta(1, Number.POSITIVE_INFINITY)));
    assert.equal(refusedAxisDelta(undefined, undefined), 0);
  });
});

describe('a geographic CRS never reaches the projected-axis arithmetic (#6700)', () => {
  // `reprojectToLatLon` returns the authored degrees from its geographic
  // branch, before any engineering-axis transform. That predates this change
  // and is why a zero-length axis still yields a pin here while it yields
  // none for a projected CRS. Pinned so the two stay distinct on purpose.
  const GEO: ProjectedCRS = { id: 1, name: 'EPSG:4326', mapProjection: 'Geographic', geodeticDatum: 'WGS84', mapUnit: 'DEGREE' };
  for (const [a, b] of [[1, 0], [2, 0], [0, 0], [Number.NaN, 0]] as const) {
    it(`axis (${a}, ${b}): the pin is the authored longitude/latitude`, async () => {
      const pin = await reprojectToLatLon(
        conversion({ eastings: 5.38, northings: 52.15, xAxisAbscissa: a, xAxisOrdinate: b }), GEO, box(1000, 2000, 30, 5), 1);
      assert.ok(pin, 'pin');
      assert.ok(Math.abs(pin.lon - 5.38) < 1e-12 && Math.abs(pin.lat - 52.15) < 1e-12, `got (${pin.lat}, ${pin.lon})`);
    });
  }
});

describe('unit axes produce the numbers they produced before #6700 (no regression)', () => {
  // EXPECTED VALUES ARE WHAT `upstream/main` PRODUCES, captured by running the
  // same calls on main and on the fix and comparing the printed JSON byte for
  // byte (identical, full double precision). This is the one test in the
  // change whose expectation equals main's output, because "unchanged for a
  // unit axis" is exactly its claim. Tolerances are 1e-9 (deg / m), far below
  // anything an axis-length mistake could produce, and wide enough that a
  // different libm's last ulp in proj4's trigonometry cannot flake the run.
  const info = box(1000, 2000, 30, 5);
  const EXPECTED: Record<string, {
    lat: number; lon: number; easting: number; northing: number;
    corner0: [number, number]; fwd: [number, number];
  }> = {
    '1,0': { lat: 36.17177487373893, lon: 9.016672641013288, easting: 501499.4, northing: 4003001.2, corner0: [9.016589292068524, 36.17184253000134], fwd: [59.976, 37.515] },
    '0,1': { lat: 36.158231614658334, lon: 8.966633771750013, easting: 496998.8, northing: 4001499.4, corner0: [8.96655038490214, 36.15816400065253], fwd: [-37.515, 59.976] },
    '0.6,0.8': { lat: 36.17176621570664, lon: 8.983306011302925, easting: 498498.68, northing: 4003000.24, corner0: [8.983189252339624, 36.17175271370825], fwd: [5.973599999999998, 70.4898] },
    '-1,0': { lat: 36.11765888198109, lon: 8.983338806726856, easting: 498500.6, northing: 3996998.8, corner0: [8.9834221269092, 36.117591248241325], fwd: [-59.976, -37.515] },
  };
  const near = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

  for (const [key, want] of Object.entries(EXPECTED)) {
    const [a, b] = key.split(',').map(Number);
    it(`axis (${key}) with Scale 1.5 and factors 0.9996 / 1.0004`, async () => {
      const conv = conversion({ xAxisAbscissa: a, xAxisOrdinate: b, scale: 1.5, factorX: 0.9996, factorY: 1.0004 });
      const pin = await reprojectToLatLon(conv, CRS, info, 1);
      assert.ok(pin, 'pin');
      near(pin.lat, want.lat, 'lat');
      near(pin.lon, want.lon, 'lon');
      const origin = await computeCesiumModelOrigin(conv, CRS, info, 1);
      assert.ok(origin, 'origin');
      near(origin.easting, want.easting, 'easting');
      near(origin.northing, want.northing, 'northing');
      const ring = await computeFootprintGeoJSON(conv, CRS, info, 1);
      assert.ok(ring, 'footprint');
      near(ring[0][0], want.corner0[0], 'corner lon');
      near(ring[0][1], want.corner0[1], 'corner lat');
      const fwd = viewerDeltaToProjectedDelta(40, -25, conv, CRS, 1);
      near(fwd.eastings, want.fwd[0], 'forward easting');
      near(fwd.northings, want.fwd[1], 'forward northing');
      const back = projectedDeltaToViewerDelta(fwd.eastings, fwd.northings, conv, CRS, 1);
      near(back.x, 40, 'round trip x');
      near(back.z, -25, 'round trip z');
    });
  }
});

describe('double-georeference diagnostics follow the same direction (#6700)', () => {
  // Map-absolute signature: geometry already sits at the declared anchor.
  const info = box(500_000, 5_000_000, 0, 1);
  const conv = (a: number, b: number) => conversion({
    eastings: 500_000, northings: 5_000_000, orthogonalHeight: 0, xAxisAbscissa: a, xAxisOrdinate: b,
  });

  it('axis (2,0) quotes the same displacement as (1,0) and is not reported as a rotation', () => {
    const identity = detectDoubleGeoreference(conv(1, 0), { mapUnitScale: 1 }, info, 1);
    const doubled = detectDoubleGeoreference(conv(2, 0), { mapUnitScale: 1 }, info, 1);
    assert.ok(identity && doubled, 'both are reported');
    assert.equal(identity.overridesAuthoredRotation, false);
    assert.equal(doubled.overridesAuthoredRotation, false, '(2,0) is the zero rotation');
    assert.ok(Math.abs(doubled.displacement - identity.displacement) < 1e-6,
      `displacement ${doubled.displacement} vs ${identity.displacement}`);
    assert.ok(Math.abs(identity.displacement - Math.hypot(500_000, 5_000_000)) < 1e-6, 'independent value');
  });

  it('axis (0,3) is a quarter turn, the same as (0,1)', () => {
    const unit = detectDoubleGeoreference(conv(0, 1), { mapUnitScale: 1 }, info, 1);
    const scaled = detectDoubleGeoreference(conv(0, 3), { mapUnitScale: 1 }, info, 1);
    assert.ok(unit && scaled, 'both are reported');
    assert.equal(scaled.overridesAuthoredRotation, true);
    assert.ok(Math.abs(scaled.displacement - unit.displacement) < 1e-6, `${scaled.displacement} vs ${unit.displacement}`);
  });

  it('a vector with no direction quotes an unknown (non-finite) displacement', () => {
    for (const [a, b] of [[0, 0], [Number.NaN, 0]] as const) {
      const found = detectDoubleGeoreference(conv(a, b), { mapUnitScale: 1 }, info, 1);
      assert.ok(found, 'still reported');
      assert.ok(!Number.isFinite(found.displacement), `displacement ${found.displacement}`);
      assert.equal(found.overridesAuthoredRotation, true);
    }
  });
});

describe('the authored vector is preserved wherever the model is read (#6700)', () => {
  it('mergeMapConversion keeps the authored ratio and the edit untouched', () => {
    const original = conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 });
    assert.equal(mergeMapConversion(original, undefined)?.xAxisAbscissa, 2);
    assert.equal(mergeMapConversion(original, undefined)?.xAxisOrdinate, 0);
    const edited = mergeMapConversion(original, { xAxisAbscissa: 3, xAxisOrdinate: 4 });
    assert.equal(edited?.xAxisAbscissa, 3);
    assert.equal(edited?.xAxisOrdinate, 4);
  });

  it('the KMZ heading input keeps the authored ratio; the heading itself is an angle (atan2), so length cannot matter', () => {
    // `buildKmz` hands the pair to the Rust exporter, whose
    // `ifc_angle_to_kml_heading` takes `atan2` of it, a function of the ratio
    // alone. The viewer must therefore pass the vector through unchanged.
    const heading = resolveKmzHeading(conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 }), CRS, 1, undefined);
    assert.deepEqual(heading, { xAxisAbscissa: 2, xAxisOrdinate: 0 });
    const oblique = resolveKmzHeading(conversion({ xAxisAbscissa: 3, xAxisOrdinate: 4 }), CRS, 1, undefined);
    assert.deepEqual(oblique, { xAxisAbscissa: 3, xAxisOrdinate: 4 });
  });

  it('computing a projection does not mutate the conversion it was given', async () => {
    const conv = Object.freeze(conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 }));
    const before = JSON.stringify(conv);
    await reprojectToLatLon(conv, CRS, box(1000, 2000, 30, 1), 1);
    await computeFootprintGeoJSON(conv, CRS, box(1000, 2000, 30, 1), 1);
    await computeCesiumModelOrigin(conv, CRS, box(1000, 2000, 30, 1), 1);
    viewerDeltaToProjectedDelta(1, 1, conv, CRS, 1);
    projectedDeltaToViewerDelta(1, 1, conv, CRS, 1);
    assert.equal(JSON.stringify(conv), before);
  });
});
