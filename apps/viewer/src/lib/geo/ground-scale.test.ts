/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchor-mode globe placement against PROJ (`__fixtures__/proj-oracle.json`,
 * written by `scripts/geo/generate-proj-oracle.py`): the convergence and point
 * scale helpers, the combined scale factor, and where a grid-coordinate model's
 * vertices land on the WGS84 globe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { computeGridPointFactors } from './proj4-utils.js';
import {
  combinedScaleFactor,
  elevationFactor,
  gridCoordinateSource,
} from './ground-scale.js';
import { computeCesiumModelOrigin, createCesiumBridge, viewerToEnuRotation } from './cesium-bridge.js';
import { getEffectiveAxisScales } from './geo-scale.js';

type OracleCase = (typeof PROJ_ORACLE.cases)[number];
const oracleCase = (prefix: string): OracleCase => {
  const found = PROJ_ORACLE.cases.find((c) => c.name.startsWith(prefix));
  assert.ok(found, `oracle case ${prefix}`);
  return found;
};

describe('grid point factors match PROJ', () => {
  for (const c of PROJ_ORACLE.cases) {
    for (const p of c.points) {
      const label = `${c.name} at ${p.lon.toFixed(2)}°E ${p.lat.toFixed(2)}°N`;
      it(`${label}: convergence and point scale on the WGS84 ellipsoid`, () => {
        const f = computeGridPointFactors(c.proj4, p.E, p.N);
        assert.ok(f);
        // Measured residuals are <= 5e-11 on both; 1e-9 leaves room for
        // proj4js/PROJ iteration tolerances while still failing the spherical
        // 111320 m/degree formula (1e-4 rad off at a 2.2° UTM convergence).
        assert.ok(Math.abs(f.gamma - p.gammaTrueNorth) < 1e-9, `gamma ${f.gamma} vs PROJ ${p.gammaTrueNorth}`);
        assert.ok(Math.abs(f.pointScale - p.kWgs84) < 1e-9, `k ${f.pointScale} vs PROJ ${p.kWgs84}`);
        if (c.sameEllipsoid) {
          // No datum shift: the WGS84 values ARE PROJ's get_factors (whose
          // convergence is positive clockwise, the opposite sign).
          const g = p.getFactors;
          const pgf = (-g.meridianConvergence * Math.PI) / 180;
          assert.ok(Math.abs(f.gamma - pgf) < 1e-9, `gamma ${f.gamma} vs get_factors ${pgf}`);
          const k = Math.sqrt(g.meridionalScale * g.parallelScale);
          assert.ok(Math.abs(f.pointScale - k) < 1e-9, `k ${f.pointScale} vs get_factors ${k}`);
        }
      });
    }
  }
});

describe('combined scale factor', () => {
  it('is the point scale at the ellipsoid and shrinks by R/(R+h) with height', () => {
    assert.equal(elevationFactor(50, 0), 1);
    const r = 6_381_000; // Gaussian mean radius near 50°N is 6.381e6 m to 4 digits
    assert.ok(Math.abs(elevationFactor(50, 500) - r / (r + 500)) < 2e-8);
    // Independent value: WGS84 R = sqrt(M·N) at 50°N = 6381822.8166 m, so
    // k_c = 0.9996 · R / (R + 500) (computed outside this module).
    assert.ok(Math.abs(combinedScaleFactor(0.9996, 50, 500) - 0.9995216899529586) < 1e-12);
  });
});

describe('gridCoordinateSource', () => {
  const kc = 0.99955;
  const plain = { operation: undefined };
  const unit = { x: 1, y: 1 };
  it('reads IfcRigidOperation and map-absolute geometry as grid coordinates', () => {
    assert.equal(gridCoordinateSource({ operation: 'rigidOperation' }, unit, false, kc), 'rigidOperation');
    assert.equal(gridCoordinateSource(plain, unit, true, kc), 'mapAbsolute');
  });
  it('leaves an effective scale of 1 (Scale 1, or a unit bridge) as true-length geometry', () => {
    assert.equal(gridCoordinateSource(plain, unit, false, kc), null);
  });
  it('reads an effective scale near k_c as the combined scale factor (Scaled factors or IFC4 Scale)', () => {
    assert.equal(gridCoordinateSource(plain, { x: 0.9996, y: 0.9996 }, false, kc), 'gridScale');
    assert.equal(gridCoordinateSource(plain, { x: 0.9996, y: 2 }, false, kc), null);
    assert.equal(gridCoordinateSource(plain, { x: 0.5, y: 0.5 }, false, kc), null);
  });
});

// ── Where a vertex lands: anchor ENU vs PROJ on the WGS84 globe ──

const A = 6378137;
const E2 = 0.0066943799901413165;
function geodeticToEcef(latDeg: number, lonDeg: number, h: number): [number, number, number] {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [
    (n + h) * Math.cos(la) * Math.cos(lo),
    (n + h) * Math.cos(la) * Math.sin(lo),
    (n * (1 - E2) + h) * Math.sin(la),
  ];
}
/** East/North of an ECEF point in the ENU frame at a geodetic anchor. */
function enuHorizontal(anchor: { latitude: number; longitude: number; height: number }, p: [number, number, number]) {
  const o = geodeticToEcef(anchor.latitude, anchor.longitude, anchor.height);
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const la = (anchor.latitude * Math.PI) / 180;
  const lo = (anchor.longitude * Math.PI) / 180;
  return {
    east: -Math.sin(lo) * d[0] + Math.cos(lo) * d[1],
    north: -Math.sin(la) * Math.cos(lo) * d[0] - Math.sin(la) * Math.sin(lo) * d[1] + Math.cos(la) * d[2],
  };
}

const CRS_FOR: Record<string, string> = {
  'UTM 32N': 'EPSG:32632',
  'ETRS89 / UTM 33N': 'EPSG:25833',
  'RGF93 / Lambert-93': 'EPSG:2154',
  'DHDN / 3-degree': 'EPSG:31468',
};

/**
 * Horizontal miss (m) of each oracle edge end when a model anchored at the
 * edge start draws the local vector (x, y) = edge / factor through the bridge.
 */
async function edgeMisses(c: OracleCase, crsName: string, conversion: Partial<MapConversion>, factor = 1) {
  const p0 = c.points[0];
  const mapConversion: MapConversion = {
    id: 1, sourceCRS: 2, targetCRS: 3, eastings: p0.E, northings: p0.N, orthogonalHeight: 120,
    xAxisAbscissa: 1, xAxisOrdinate: 0, ...conversion,
  };
  const crs: ProjectedCRS = { id: 3, name: crsName, mapUnit: 'METRE', mapUnitScale: 1 };
  const bridge = await createCesiumBridge(mapConversion, crs, undefined, 1);
  assert.ok(bridge);
  const rot = bridge.viewerRotation;
  return c.edges.map((edge) => {
    // IFC (x, y) → viewer (vx, vz) = (x, −y).
    const vx = edge.dE / factor;
    const vz = -edge.dN / factor;
    const drawn = { east: rot.eastFromVx * vx + rot.eastFromVz * vz, north: rot.northFromVx * vx + rot.northFromVz * vz };
    const truth = enuHorizontal(bridge.modelOrigin, geodeticToEcef(edge.lat, edge.lon, bridge.modelOrigin.height));
    return { length: Math.hypot(edge.dE, edge.dN), miss: Math.hypot(drawn.east - truth.east, drawn.north - truth.north) };
  });
}

/**
 * Tolerance per edge length: 2 mm up to 500 m, otherwise the error budget's
 * "best anchor" curve (scale and convergence variation across the site, which
 * an anchor cannot model; 55 mm at 5 km on UTM 2.9° off the central meridian).
 */
const anchorTolerance = (length: number) => (length <= 500 ? 0.002 : 1.2e-5 * length);

describe('grid-coordinate models land on PROJ positions in anchor mode', () => {
  for (const [prefix, crsName] of Object.entries(CRS_FOR)) {
    const c = oracleCase(prefix);
    it(`IfcRigidOperation in ${c.name}: drawn at ground length (1/k_c)`, async () => {
      for (const { length, miss } of await edgeMisses(c, crsName, { operation: 'rigidOperation' })) {
        assert.ok(miss < anchorTolerance(length), `${length} m edge misses PROJ by ${(miss * 1000).toFixed(2)} mm`);
      }
    });
  }

  it('IfcMapConversionScaled with FactorX/Y = k_c: local ground lengths land on Scale·Factor·x map coordinates', async () => {
    const c = oracleCase('UTM 32N');
    const origin = await computeCesiumModelOrigin(
      { id: 1, sourceCRS: 2, targetCRS: 3, eastings: c.points[0].E, northings: c.points[0].N, orthogonalHeight: 120 },
      { id: 3, name: 'EPSG:32632', mapUnitScale: 1 },
    );
    assert.ok(origin);
    // The surveyor's project constant, rounded as authored in practice.
    const factor = Number(origin.combinedScaleFactor.toFixed(6));
    for (const { length, miss } of await edgeMisses(c, 'EPSG:32632', { factorX: factor, factorY: factor, factorZ: 1 }, factor)) {
      assert.ok(miss < anchorTolerance(length), `${length} m edge misses PROJ by ${(miss * 1000).toFixed(2)} mm`);
    }
  });

  it('without 1/k_c the same rigid-operation model misses by the scale term (the pre-fix placement)', async () => {
    const c = oracleCase('UTM 32N');
    const origin = await computeCesiumModelOrigin(
      { id: 1, sourceCRS: 2, targetCRS: 3, eastings: c.points[0].E, northings: c.points[0].N, orthogonalHeight: 120, operation: 'rigidOperation' },
      { id: 3, name: 'EPSG:32632', mapUnitScale: 1 },
    );
    assert.ok(origin);
    assert.equal(origin.gridSource, 'rigidOperation');
    // |1 − 1/k_c| · 500 m on the UTM central meridian: about 0.2 m.
    assert.ok(Math.abs(1 - origin.groundScale) * 500 > 0.19);
  });
});

describe('IFC4 IfcMapConversion carrying the grid factor in Scale', () => {
  it('places like the buildingSMART georeferenced-bridge-deck sample (UTM 10N, Scale 0.9996) at ground length', async () => {
    // That sample's conversion, unrotated here so only the scale is under test.
    const origin = await computeCesiumModelOrigin(
      { id: 38, sourceCRS: 10, targetCRS: 37, eastings: 545991.679663973, northings: 4184941.96970872, orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 0.9996 },
      { id: 37, name: 'EPSG:32610', mapUnitScale: 1 },
    );
    assert.ok(origin);
    assert.equal(origin.gridSource, 'gridScale');
    // Drawn at Scale/k_c: 0.9996 against k_c = k·R/(R+h) of that point (k 0.99963 there).
    assert.ok(Math.abs(origin.scaleX * origin.groundScale - 0.9996 / origin.combinedScaleFactor) < 1e-15);
    assert.ok(Math.abs(origin.scaleX * origin.groundScale - 1) < 1e-4);
  });
});

describe('plain IfcMapConversion stays true-length (regression, #8174)', () => {
  it('a small UTM model is placed with exactly the authored effective scale and no 1/k_c', async () => {
    const c = oracleCase('UTM 32N');
    const conversion: MapConversion = {
      id: 1, sourceCRS: 2, targetCRS: 3, eastings: c.points[1].E, northings: c.points[1].N, orthogonalHeight: 55,
      xAxisAbscissa: 0.8, xAxisOrdinate: 0.6, scale: 1,
    };
    const crs: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };
    const origin = await computeCesiumModelOrigin(conversion, crs, undefined, 1);
    const bridge = await createCesiumBridge(conversion, crs, undefined, 1);
    assert.ok(origin && bridge);
    assert.equal(origin.gridSource, null);
    assert.equal(origin.groundScale, 1);
    const s = getEffectiveAxisScales(conversion, 1, 1);
    // Bitwise: the rotation is the authored Helmert + convergence, nothing else.
    assert.deepEqual(bridge.viewerRotation, viewerToEnuRotation(s.x, 0.8, 0.6, origin.gamma, s.y));
    // ...and the convergence is PROJ's to 1e-9 rad.
    assert.ok(Math.abs(origin.gamma - c.points[1].gammaTrueNorth) < 1e-9);
  });

  it('IfcMapConversionScaled with unit horizontal factors keeps its literal (true-length) meaning', async () => {
    const c = oracleCase('UTM 32N');
    const origin = await computeCesiumModelOrigin(
      { id: 1, sourceCRS: 2, targetCRS: 3, eastings: c.points[0].E, northings: c.points[0].N, orthogonalHeight: 0, factorX: 1, factorY: 1, factorZ: 2 },
      { id: 3, name: 'EPSG:32632', mapUnitScale: 1 },
    );
    assert.ok(origin);
    assert.equal(origin.groundScale, 1);
  });
});
