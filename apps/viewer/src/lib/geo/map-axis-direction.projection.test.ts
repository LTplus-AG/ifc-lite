/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6700: `IfcMapConversion.XAxisAbscissa` / `XAxisOrdinate` give the DIRECTION
 * of the local X axis. Rotation comes from the angle of that vector and `Scale`
 * is applied separately, so `(1, 0)` and `(2, 0)` are the same zero rotation.
 *
 * Every test here goes through the real projection / placement API, never
 * through a helper written for the test. The expected values are computed in
 * the test body from the spec formula, with the axis normalised HERE
 * (`unit()`), independently of the production code under test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { localViewerToProjected, projectedToLocalViewer, resolveSpatialPlacement } from '@ifc-lite/geometry';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { computeCesiumModelOrigin, createCesiumBridge } from './cesium-bridge.js';
import {
  projectedDeltaToViewerDelta,
  projectedDeltaToViewerDeltaForGeometry,
  viewerDeltaToProjectedDelta,
  viewerDeltaToProjectedDeltaForGeometry,
} from './cesium-placement.js';
import { spatialReferenceFromIfc } from './ifc-spatial-reference.js';
import { viewerPointToProjected, type MapGeoreference } from './pick-to-geo.js';
import { computeFootprintGeoJSON, reprojectToLatLon, resolveProjection } from './reproject.js';

const CRS: ProjectedCRS = { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 };

function conversion(over: Partial<MapConversion> = {}): MapConversion {
  return { id: 2, sourceCRS: 1, targetCRS: 1, eastings: 0, northings: 0, orthogonalHeight: 0, scale: 1, ...over };
}

/** A box of half-width `half` centred on IFC (x, y, z) in metres; no shift, no RTC. */
function infoAt(ifcX: number, ifcY: number, ifcZ = 0, half = 1): CoordinateInfo {
  // IFC Z-up -> viewer Y-up: viewer (x, y, z) = (ifcX, ifcZ, -ifcY).
  const min = { x: ifcX - half, y: ifcZ - half, z: -ifcY - half };
  const max = { x: ifcX + half, y: ifcZ + half, z: -ifcY + half };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min, max },
    shiftedBounds: { min, max },
    hasLargeCoordinates: false,
  };
}

/** The unit direction of an authored axis vector, normalised independently of production code. */
function unit(abscissa: number, ordinate: number): { a: number; b: number } {
  const length = Math.hypot(abscissa, ordinate);
  return { a: abscissa / length, b: ordinate / length };
}

/** Spec formula: E = E0 + a*sx*x - b*sy*y, N = N0 + b*sx*x + a*sy*y (x, y in IFC metres). */
function expectedEN(
  axis: readonly [number, number], x: number, y: number,
  origin: { e: number; n: number } = { e: 0, n: 0 }, sx = 1, sy = sx,
): { e: number; n: number } {
  const { a, b } = unit(axis[0], axis[1]);
  return { e: origin.e + a * sx * x - b * sy * y, n: origin.n + b * sx * x + a * sy * y };
}

async function toLatLon(e: number, n: number): Promise<{ lat: number; lon: number }> {
  const def = await resolveProjection(CRS);
  assert.ok(def, 'EPSG:32632 must resolve');
  const [lon, lat] = proj4(def, 'WGS84', [e, n]);
  return { lat, lon };
}

async function toEN(lon: number, lat: number): Promise<{ e: number; n: number }> {
  const def = await resolveProjection(CRS);
  assert.ok(def, 'EPSG:32632 must resolve');
  const [e, n] = proj4('WGS84', def, [lon, lat]);
  return { e, n };
}

/**
 * Tolerance for lat/lon equality, in degrees. Two equivalent axis vectors
 * normalise to values within ~1e-16, which at 5e5 / 4e6 m is ~1e-9 m, or about
 * 1e-14 deg; 1e-9 deg (~0.1 mm) leaves five orders of margin for proj4 while
 * the unfixed code is off by kilometres (>= 1e-2 deg).
 */
const DEG_TOL = 1e-9;
/** Metres. Double-precision ulp at 4e6 is 9e-10 m; 1e-6 m is three orders above that. */
const M_TOL = 1e-6;

function assertLatLon(actual: { lat: number; lon: number } | null, expected: { lat: number; lon: number }, label: string): void {
  assert.ok(actual, `${label}: expected a lat/lon, got null`);
  assert.ok(
    Math.abs(actual.lat - expected.lat) < DEG_TOL && Math.abs(actual.lon - expected.lon) < DEG_TOL,
    `${label}: got (${actual.lat}, ${actual.lon}), expected (${expected.lat}, ${expected.lon})`,
  );
}

function georef(conv: MapConversion, lengthUnitScale = 1, crs: ProjectedCRS = CRS): MapGeoreference {
  return { hasGeoreference: true, source: 'mapConversion', projectedCRS: crs, mapConversion: conv, lengthUnitScale };
}

describe('#6700 stated invariant: axis (1,0) and (2,0) project the same point', () => {
  // Metre model, metre CRS, offsets (0,0,0), Scale 1, factors 1, engineering
  // point (500000, 4000000).
  const info = infoAt(500_000, 4_000_000);

  for (const axis of [[1, 0], [2, 0], [0.5, 0]] as const) {
    it(`reprojectToLatLon: axis (${axis[0]}, ${axis[1]}) lands on the engineering point itself`, async () => {
      const actual = await reprojectToLatLon(
        conversion({ xAxisAbscissa: axis[0], xAxisOrdinate: axis[1] }), CRS, info, 1);
      assertLatLon(actual, await toLatLon(500_000, 4_000_000), `axis (${axis})`);
    });

    it(`computeCesiumModelOrigin: axis (${axis[0]}, ${axis[1]}) gives easting/northing (500000, 4000000)`, async () => {
      const origin = await computeCesiumModelOrigin(
        conversion({ xAxisAbscissa: axis[0], xAxisOrdinate: axis[1] }), CRS, info, 1);
      assert.ok(origin, `axis (${axis}): expected an origin`);
      assert.ok(Math.abs(origin.easting - 500_000) < M_TOL, `easting ${origin.easting}`);
      assert.ok(Math.abs(origin.northing - 4_000_000) < M_TOL, `northing ${origin.northing}`);
    });
  }
});

describe('#6700 oblique equivalents give identical results', () => {
  // Offsets and a point of moderate size so a magnitude error is visible
  // without leaving the UTM zone.
  const origin = { e: 500_000, n: 4_000_000 };
  const x = 1000;
  const y = 2000;
  const info = infoAt(x, y, 30);
  const families: ReadonlyArray<readonly (readonly [number, number])[]> = [
    [[1, 1], [2, 2], [0.70710678, 0.70710678], [100, 100]],
    [[3, 4], [0.6, 0.8], [30, 40], [0.03, 0.04]],
    [[0, 1], [0, 7]],
    [[-1, 0], [-3, 0]],
  ];

  for (const family of families) {
    for (const axis of family) {
      it(`centre: axis (${axis}) matches the unit direction of the family`, async () => {
        const expected = expectedEN(family[0], x, y, origin);
        const actual = await reprojectToLatLon(
          conversion({ eastings: origin.e, northings: origin.n, xAxisAbscissa: axis[0], xAxisOrdinate: axis[1] }),
          CRS, info, 1);
        const exp = await toLatLon(expected.e, expected.n);
        assert.ok(actual, `axis (${axis}): expected a lat/lon`);
        assert.ok(
          Math.abs(actual.lat - exp.lat) < DEG_TOL && Math.abs(actual.lon - exp.lon) < DEG_TOL,
          `axis (${axis}): got (${actual.lat}, ${actual.lon}), expected (${exp.lat}, ${exp.lon})`);
      });
    }
  }
});

describe('#6700 Scale and IfcMapConversionScaled factors apply once, separately from the direction', () => {
  const origin = { e: 500_000, n: 4_000_000 };
  const x = 1000;
  const y = 2000;
  const info = infoAt(x, y, 30);

  it('Scale 3 with axis (2,0) scales by 3 only, not by 3 x 2', async () => {
    const actual = await reprojectToLatLon(
      conversion({ eastings: origin.e, northings: origin.n, xAxisAbscissa: 2, xAxisOrdinate: 0, scale: 3 }), CRS, info, 1);
    const e = expectedEN([1, 0], x, y, origin, 3);
    assertLatLon(actual, await toLatLon(e.e, e.n), 'scale 3');
  });

  it('Scale 2, FactorX 0.9, FactorY 1.1 with oblique axis (3,4) applies each exactly once', async () => {
    const conv = conversion({
      eastings: origin.e, northings: origin.n, xAxisAbscissa: 3, xAxisOrdinate: 4, scale: 2, factorX: 0.9, factorY: 1.1, factorZ: 1,
    });
    const e = expectedEN([3, 4], x, y, origin, 2 * 0.9, 2 * 1.1);
    assertLatLon(await reprojectToLatLon(conv, CRS, info, 1), await toLatLon(e.e, e.n), 'centre');
    const o = await computeCesiumModelOrigin(conv, CRS, info, 1);
    assert.ok(o, 'expected an origin');
    assert.ok(Math.abs(o.easting - e.e) < M_TOL && Math.abs(o.northing - e.n) < M_TOL,
      `origin (${o.easting}, ${o.northing}) vs expected (${e.e}, ${e.n})`);
    assert.ok(Math.abs(o.scaleX - 1.8) < 1e-12 && Math.abs(o.scaleY - 2.2) < 1e-12,
      `the origin's own scales are the authored ones, got (${o.scaleX}, ${o.scaleY})`);
  });

  it('millimetre model with a metre CRS: Scale 0.001 bridges the units, a (2,0) axis adds nothing', async () => {
    // Geometry is already metres. Eastings/Northings are metres (CRS unit is
    // METRE). Scale 0.001 in a millimetre project: effective (0.001 * 1) / 0.001 = 1.
    const conv = conversion({ eastings: origin.e, northings: origin.n, xAxisAbscissa: 2, xAxisOrdinate: 0, scale: 0.001 });
    const e = expectedEN([1, 0], x, y, origin, 1);
    assertLatLon(await reprojectToLatLon(conv, CRS, info, 0.001), await toLatLon(e.e, e.n), 'mm project, explicit Scale');
  });

  it('millimetre model with a metre CRS and Scale unset: the #595 heuristic still sees a unit scale under a (2,0) axis', async () => {
    const conv = conversion({ eastings: origin.e, northings: origin.n, xAxisAbscissa: 2, xAxisOrdinate: 0, scale: undefined });
    const e = expectedEN([1, 0], x, y, origin, 1);
    assertLatLon(await reprojectToLatLon(conv, CRS, info, 0.001), await toLatLon(e.e, e.n), 'mm project, Scale unset');
  });

  it('millimetre CRS (mapUnitScale 0.001) with a millimetre model: offsets in mm, axis (0,5) is a pure quarter turn', async () => {
    const mmCrs: ProjectedCRS = { ...CRS, mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 };
    const conv = conversion({ eastings: origin.e * 1000, northings: origin.n * 1000, xAxisAbscissa: 0, xAxisOrdinate: 5, scale: 1 });
    const e = expectedEN([0, 1], x, y, origin, 1);
    assertLatLon(await reprojectToLatLon(conv, mmCrs, info, 0.001), await toLatLon(e.e, e.n), 'mm CRS');
  });
});

describe('#6700 footprint agrees with the centre under a non-unit axis', () => {
  const origin = { e: 500_000, n: 4_000_000 };
  const x = 1000;
  const y = 2000;
  const half = 5;
  const info = infoAt(x, y, 30, half);
  /** A footprint corner is 1e-4 m (0.1 mm) from the spec value: proj4's own round trip is ~1e-6 m. */
  const FOOTPRINT_TOL = 1e-4;

  for (const axis of [[3, 4], [0.6, 0.8], [2, 0]] as const) {
    it(`axis (${axis}), Scale 2: corners, centroid and edge length follow the unit direction`, async () => {
      const conv = conversion({ eastings: origin.e, northings: origin.n, xAxisAbscissa: axis[0], xAxisOrdinate: axis[1], scale: 2 });
      const ring = await computeFootprintGeoJSON(conv, CRS, info, 1);
      assert.ok(ring, 'expected a footprint ring');
      assert.equal(ring.length, 5, 'closed ring');
      const corners = await Promise.all(ring.slice(0, 4).map(([lon, lat]) => toEN(lon, lat)));
      // Corner order is min/min, max/min, max/max, min/max on the viewer XZ plane.
      const ifcCorners: ReadonlyArray<readonly [number, number]> = [
        [x - half, y + half], [x + half, y + half], [x + half, y - half], [x - half, y - half],
      ];
      ifcCorners.forEach(([cx, cy], i) => {
        const e = expectedEN(axis, cx, cy, origin, 2);
        assert.ok(
          Math.abs(corners[i].e - e.e) < FOOTPRINT_TOL && Math.abs(corners[i].n - e.n) < FOOTPRINT_TOL,
          `corner ${i}: got (${corners[i].e}, ${corners[i].n}), expected (${e.e}, ${e.n})`);
      });
      const edge = Math.hypot(corners[1].e - corners[0].e, corners[1].n - corners[0].n);
      assert.ok(Math.abs(edge - 2 * half * 2) < FOOTPRINT_TOL, `edge is 2*half*Scale = 20 m, got ${edge}`);
      // Centre agreement: the centroid of the four corners is the pin.
      const centroid = {
        e: corners.reduce((s, c) => s + c.e, 0) / 4,
        n: corners.reduce((s, c) => s + c.n, 0) / 4,
      };
      const pin = await reprojectToLatLon(conv, CRS, info, 1);
      assert.ok(pin, 'expected a pin');
      const pinEN = await toEN(pin.lon, pin.lat);
      assert.ok(Math.abs(centroid.e - pinEN.e) < FOOTPRINT_TOL && Math.abs(centroid.n - pinEN.n) < FOOTPRINT_TOL,
        `centroid (${centroid.e}, ${centroid.n}) must equal the pin (${pinEN.e}, ${pinEN.n})`);
    });
  }
});

describe('#6700 forward and inverse placement helpers', () => {
  // Deltas are relative, so they are small (tens of metres): the tolerance on
  // a round trip is then limited by the 5e5 / 4e6 absolute coordinates added
  // in `viewerPointToProjected`, whose ulp is 6e-11 / 9e-10 m.
  const dx = 40;
  const dz = -25;

  it('forward: axis (2,0) moves the point by the delta, not twice the delta', () => {
    const d = viewerDeltaToProjectedDelta(dx, dz, conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 }), CRS, 1);
    const e = expectedEN([1, 0], dx, -dz);
    assert.ok(Math.abs(d.eastings - e.e) < M_TOL && Math.abs(d.northings - e.n) < M_TOL,
      `got (${d.eastings}, ${d.northings}), expected (${e.e}, ${e.n})`);
  });

  it('forward: oblique (3,4) with Scale 2 and factors scales by Scale x Factor only', () => {
    const conv = conversion({ xAxisAbscissa: 3, xAxisOrdinate: 4, scale: 2, factorX: 0.9, factorY: 1.1 });
    const d = viewerDeltaToProjectedDelta(dx, dz, conv, CRS, 1);
    const e = expectedEN([0.6, 0.8], dx, -dz, undefined, 1.8, 2.2);
    assert.ok(Math.abs(d.eastings - e.e) < M_TOL && Math.abs(d.northings - e.n) < M_TOL,
      `got (${d.eastings}, ${d.northings}), expected (${e.e}, ${e.n})`);
  });

  it('inverse: a projected delta maps back to the unit-direction viewer delta', () => {
    const conv = conversion({ xAxisAbscissa: 3, xAxisOrdinate: 4, scale: 2, factorX: 0.9, factorY: 1.1 });
    const e = expectedEN([0.6, 0.8], dx, -dz, undefined, 1.8, 2.2);
    const back = projectedDeltaToViewerDelta(e.e, e.n, conv, CRS, 1);
    assert.ok(Math.abs(back.x - dx) < M_TOL && Math.abs(back.z - dz) < M_TOL,
      `got (${back.x}, ${back.z}), expected (${dx}, ${dz})`);
  });

  it('inverse: a projected delta of 10 m east under axis (2,0) is 10 m of viewer X, not 2.5', () => {
    const back = projectedDeltaToViewerDelta(10, 0, conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 }), CRS, 1);
    assert.ok(Math.abs(back.x - 10) < M_TOL && Math.abs(back.z) < M_TOL, `got (${back.x}, ${back.z})`);
  });

  for (const axis of [[1, 0], [2, 0], [3, 4], [0.5, 0], [-2, 2]] as const) {
    it(`round trip forward -> inverse returns the viewer delta, axis (${axis})`, () => {
      const conv = conversion({ xAxisAbscissa: axis[0], xAxisOrdinate: axis[1], scale: 1.5, factorX: 0.9996, factorY: 1.0004 });
      const fwd = viewerDeltaToProjectedDelta(dx, dz, conv, CRS, 1);
      const back = projectedDeltaToViewerDelta(fwd.eastings, fwd.northings, conv, CRS, 1);
      assert.ok(Math.abs(back.x - dx) < M_TOL && Math.abs(back.z - dz) < M_TOL,
        `axis (${axis}): got (${back.x}, ${back.z}), expected (${dx}, ${dz})`);
    });
  }

  it('the geometry-guarded variants route through the same normalisation', () => {
    const conv = conversion({ xAxisAbscissa: 2, xAxisOrdinate: 0 });
    const info = infoAt(0, 0);
    const fwd = viewerDeltaToProjectedDeltaForGeometry(dx, dz, conv, CRS, 1, info);
    assert.ok(Math.abs(fwd.eastings - dx) < M_TOL, `forward easting ${fwd.eastings}`);
    const back = projectedDeltaToViewerDeltaForGeometry(10, 0, conv, CRS, 1, info);
    assert.ok(Math.abs(back.x - 10) < M_TOL, `inverse x ${back.x}`);
  });

  it('pick readout (viewerPointToProjected) agrees with the centre for axis (2,0) and (3,4), mm model', () => {
    // building-architecture shape: millimetre project, millimetre map unit.
    const mmCrs: ProjectedCRS = { ...CRS, mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 };
    for (const axis of [[2, 0], [3, 4]] as const) {
      const conv = conversion({ eastings: 500_000_000, northings: 4_000_000_000, xAxisAbscissa: axis[0], xAxisOrdinate: axis[1], scale: 1 });
      // Viewer point (1000, 30, -2000) m = IFC (1000, 2000, 30) m; origin at 0.
      const p = viewerPointToProjected({ x: 1000, y: 30, z: -2000 }, georef(conv, 0.001, mmCrs), { x: 0, y: 0, z: 0 });
      const e = expectedEN(axis, 1000, 2000, { e: 500_000, n: 4_000_000 });
      // Result is in the authored map unit (mm).
      assert.ok(Math.abs(p.eastings / 1000 - e.e) < M_TOL && Math.abs(p.northings / 1000 - e.n) < M_TOL,
        `axis (${axis}): got (${p.eastings / 1000}, ${p.northings / 1000}) m, expected (${e.e}, ${e.n})`);
    }
  });
});

describe('#6700 Cesium model rotation carries no extra scale from the axis magnitude', () => {
  it('createCesiumBridge: the horizontal columns of viewerRotation have length Scale for any axis magnitude', async () => {
    const info = infoAt(1000, 2000, 30);
    for (const axis of [[1, 0], [2, 0], [3, 4], [0.5, 0]] as const) {
      const bridge = await createCesiumBridge(
        conversion({ eastings: 500_000, northings: 4_000_000, xAxisAbscissa: axis[0], xAxisOrdinate: axis[1], scale: 1 }),
        CRS, info, 1);
      assert.ok(bridge, `axis (${axis}): expected a bridge`);
      const r = bridge.viewerRotation;
      const colX = Math.hypot(r.eastFromVx, r.northFromVx);
      const colZ = Math.hypot(r.eastFromVz, r.northFromVz);
      assert.ok(Math.abs(colX - 1) < 1e-12 && Math.abs(colZ - 1) < 1e-12,
        `axis (${axis}): column lengths (${colX}, ${colZ}) must be Scale = 1`);
    }
  });
});

describe('#6700 audit: the shared spatial-reference boundary', () => {
  const lengthUnitScale = 1;
  const point: readonly [number, number, number] = [1000, 30, -2000];

  for (const [axis, ref] of [[[2, 0], [1, 0]], [[3, 4], [0.6, 0.8]], [[0.5, 0], [1, 0]]] as const) {
    it(`spatialReferenceFromIfc + localViewerToProjected: axis (${axis}) equals (${ref}) and keeps the authored vector`, () => {
      const make = (a: readonly [number, number]) => spatialReferenceFromIfc({
        mapConversion: { id: 2, sourceCRS: 1, targetCRS: 1, eastings: 500_000, northings: 4_000_000, orthogonalHeight: 10, xAxisAbscissa: a[0], xAxisOrdinate: a[1], scale: 1 },
        projectedCRS: CRS, lengthUnitScale,
      });
      const actual = make(axis);
      const reference = make(ref);
      const p = localViewerToProjected(actual, point);
      const q = localViewerToProjected(reference, point);
      assert.ok(p && q, 'both project');
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(p[i] - q[i]) < M_TOL, `component ${i}: ${p[i]} vs ${q[i]}`);
      // Authored values are carried untouched into the shared boundary.
      assert.equal(actual.localToProjected?.xAxisAbscissa, axis[0]);
      assert.equal(actual.localToProjected?.xAxisOrdinate, axis[1]);
      // Inverse round trip.
      const back = projectedToLocalViewer(actual, p);
      assert.ok(back, 'inverse resolves');
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - point[i]) < M_TOL, `round trip component ${i}: ${back[i]} vs ${point[i]}`);
    });
  }

  it('resolveSpatialPlacement: two references that differ only by axis magnitude are the identity placement', () => {
    const make = (a: readonly [number, number]) => spatialReferenceFromIfc({
      mapConversion: { id: 2, sourceCRS: 1, targetCRS: 1, eastings: 500_000, northings: 4_000_000, orthogonalHeight: 10, xAxisAbscissa: a[0], xAxisOrdinate: a[1], scale: 1 },
      projectedCRS: CRS, lengthUnitScale,
    });
    const result = resolveSpatialPlacement(make([2, 0]), make([1, 0]), { unknownVertical: 'assume-compatible' });
    assert.ok(result.ok, 'placement resolves');
    assert.equal(result.placement.status, 'identity');
  });
});
