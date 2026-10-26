/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GeoWarp against PROJ: `__fixtures__/proj-oracle.json` (`warp`, written by
 * `scripts/geo/generate-proj-oracle.py`) carries E, N, H → lon, lat, h, ECEF
 * along a 20 km line, with a stated geoid plane both sides use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';

import type { MeshData } from '@ifc-lite/geometry';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { createGeoMapping, createLatticeWarp, ecefToEnuAt, linearizeWarp, type GeoMapping } from './geo-warp.js';
import { bakeGlobeTiles, GLOBE_TILE_M } from './globe-glb.js';
import { buildMergedGLB } from './cesium-glb.js';
import { estimateAnchorError, resolveGlobePlacement } from './globe-placement.js';
import { buildLinearizedViewerToEcefMatrix } from './cesium-viewer-frame.js';
import { loadCesium } from '@/components/viewer/cesium/cesium-module';

type WarpCase = (typeof PROJ_ORACLE.warp)[number];
const G = PROJ_ORACLE.warpGeoid;

/**
 * A rigid-operation style mapping: viewer (x, y, -z) are map metres from the
 * anchor (E0, N0) and the orthometric height, exactly what the oracle sampled.
 */
function oracleMapping(c: WarpCase, gridCoordinates = true, combinedScaleFactor = 1): GeoMapping {
  const [lon0, lat0] = proj4(c.proj4, 'WGS84', [c.anchor.E, c.anchor.N]);
  const geoid = (lat: number, lon: number) => G.n0 + G.perDegLat * (lat - lat0) + G.perDegLon * (lon - lon0);
  return createGeoMapping({
    projDef: c.proj4,
    eastingsM: c.anchor.E,
    northingsM: c.anchor.N,
    orthogonalHeightM: 0,
    axis: { a: 1, b: 0 },
    scales: { x: 1, y: 1, z: 1 },
    coordinateInfo: undefined,
    anchor: {
      longitude: lon0, latitude: lat0, height: c.anchor.H + geoid(lat0, lon0),
      ifcOriginHeight: c.anchor.H, geoidUndulation: geoid(lat0, lon0), easting: c.anchor.E, northing: c.anchor.N,
    },
    combinedScaleFactor,
    gridCoordinates,
    geoid,
  });
}

/** Viewer coordinates of an oracle point: IFC (x, y, z) = (dE, dN, H) → viewer (x, z up, −y). */
const viewerOf = (p: { dE: number; dN: number; H: number }) => [p.dE, p.H, -p.dN] as const;

function oracleEnu(c: WarpCase, m: GeoMapping) {
  const toEnu = ecefToEnuAt(m.anchor.latitude, m.anchor.longitude, m.anchor.height);
  return c.points.map((p) => {
    const out = [0, 0, 0];
    toEnu(p.ecef[0], p.ecef[1], p.ecef[2], out);
    return out;
  });
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('GeoWarp exact mapping vs PROJ (E, N, H → ECEF)', () => {
  for (const c of PROJ_ORACLE.warp) {
    it(`${c.case} at ${c.anchor.lon.toFixed(2)}°E: every point of a 20 km line within 1 mm`, () => {
      const m = oracleMapping(c);
      const truth = oracleEnu(c, m);
      let worst = 0;
      c.points.forEach((p, i) => {
        const out = [0, 0, 0];
        assert.ok(m.toEnu(...viewerOf(p), out));
        worst = Math.max(worst, dist(out, truth[i]));
      });
      // proj4js and PROJ agree to micrometres on these CRSs (the oracle header).
      assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    });
  }
});

describe('GeoWarp lattice vs exact', () => {
  for (const c of PROJ_ORACLE.warp) {
    it(`${c.case} at ${c.anchor.lon.toFixed(2)}°E: 100 m lattice interpolates the 20 km line within 1 mm`, () => {
      const m = oracleMapping(c);
      const truth = oracleEnu(c, m);
      const xs = c.points.map((p) => p.dE), ns = c.points.map((p) => -p.dN), hs = c.points.map((p) => p.H);
      // Bounds offset by 37 m so oracle points fall between lattice nodes, not on them.
      const lattice = createLatticeWarp(m, {
        min: { x: Math.min(...xs) - 37, y: Math.min(...hs), z: Math.min(...ns) - 37 },
        max: { x: Math.max(...xs), y: Math.max(...hs), z: Math.max(...ns) },
      });
      assert.ok(lattice);
      let worst = 0;
      c.points.forEach((p, i) => {
        const out = [0, 0, 0];
        lattice.warp(...viewerOf(p), out);
        worst = Math.max(worst, dist(out, truth[i]));
      });
      assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    });
  }
});

describe('GeoWarp semantics', () => {
  const c = PROJ_ORACLE.warp[0];
  it('true-length geometry (plain IfcMapConversion) keeps its length at the anchor', () => {
    // UTM central meridian, 120 m up: k_c = 0.9996 · R/(R+h). The mapping
    // projects E_a + k_c·(E − E_a), so 100 m of model is 100 m on the globe.
    const kc = 0.9996 * (6_381_000 / (6_381_000 + c.anchor.H + G.n0));
    const m = oracleMapping(c, false, kc);
    const a = [0, 0, 0], b = [0, 0, 0];
    m.toEnu(0, c.anchor.H, 0, a);
    m.toEnu(100, c.anchor.H, 0, b);
    assert.ok(Math.abs(dist(a, b) - 100) < 2e-4, `drawn ${dist(a, b)} m`);
  });

  it('the warp bends with the Earth: 10 km from the anchor sits r²/2R below its tangent plane', () => {
    const m = oracleMapping(c);
    const out = [0, 0, 0];
    m.toEnu(10_000, c.anchor.H, 0, out);
    const drop = -out[2];
    // r²/(2R) with R between the meridian and prime-vertical radii, plus the geoid plane's slope.
    assert.ok(drop > 7.4 && drop < 8.2, `drop ${drop} m`);
  });
});

describe('Exact GLB bake', () => {
  const c = PROJ_ORACLE.warp[1];
  const m = oracleMapping(c);
  // One small triangle every 500 m along the line, with a +x normal (a wall facing grid east).
  const meshes: MeshData[] = c.points.filter((p) => p.H === 100).map((p, i) => {
    const [x, y, z] = viewerOf(p);
    return {
      expressId: i + 1,
      positions: new Float32Array([0, 0, 0, 0, 3, 0, 0, 0, -2]),
      normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      origin: [x, y, z],
    } as MeshData;
  });

  function readGlb(glb: Uint8Array) {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLen = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
    const binStart = 20 + jsonLen + 8;
    const count = json.accessors[0].count as number;
    const positions = new Float32Array(glb.slice(binStart, binStart + count * 12).buffer);
    const normals = new Float32Array(glb.slice(binStart + count * 12, binStart + count * 24).buffer);
    return { node: json.nodes[0], positions, normals };
  }

  it('lands every vertex within 1 mm of PROJ through float32 tiles of at most 2 km', () => {
    const tiles = bakeGlobeTiles(meshes, m);
    assert.ok(tiles && tiles.length > 1, 'a 20 km line spans several tiles');
    const truth = c.points.filter((p) => p.H === 100);
    const truthEnu = oracleEnu({ ...c, points: truth }, m);
    let worst = 0;
    let checked = 0;
    for (const tile of tiles) {
      const { node, positions } = readGlb(buildMergedGLB(tile.meshes, tile.translation));
      assert.deepEqual(node.translation, tile.translation);
      for (const mesh of tile.meshes) {
        const k = mesh.expressId - 1;
        const at = tile.meshes.indexOf(mesh) * 9; // first vertex = the oracle point
        const enu = [positions[at] + node.translation[0], positions[at + 1] + node.translation[1], positions[at + 2] + node.translation[2]];
        worst = Math.max(worst, dist(enu, truthEnu[k]));
        // Float32 needs the tile-relative magnitude small: within a tile's half-diagonal.
        assert.ok(Math.hypot(positions[at], positions[at + 1]) <= GLOBE_TILE_M * Math.SQRT1_2 + 1);
        checked++;
      }
    }
    assert.equal(checked, truth.length);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
  });

  it('rotates normals into ENU: a grid-east wall faces true east turned by the convergence', () => {
    const tiles = bakeGlobeTiles(meshes.slice(20, 21), m);
    assert.ok(tiles);
    const { normals } = readGlb(buildMergedGLB(tiles[0].meshes, tiles[0].translation));
    const n = [normals[0], normals[1], normals[2]];
    assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-6);
    // UTM 32N 2.9° east of the CM at 50°N: grid east is 2.2° from true east (PROJ: 0.0388 rad).
    const gamma = PROJ_ORACLE.cases[0].points[1].gammaTrueNorth;
    assert.ok(Math.abs(Math.atan2(n[1], n[0]) - gamma) < 2e-4, `normal bearing ${Math.atan2(n[1], n[0])}`);
    assert.ok(Math.abs(n[2]) < 2e-3, 'stays horizontal to the local tilt');
  });
});

describe('Exact camera frame', () => {
  it('matches the baked model at the camera target and to d²/2R around it', async () => {
    const Cesium = await loadCesium();
    const c = PROJ_ORACLE.warp[0];
    const m = oracleMapping(c);
    const target = { x: 6000, y: 130, z: -4000 };
    const lin = linearizeWarp(m.toEnu, target.x, target.y, target.z);
    assert.ok(lin);
    const anchor = { longitude: m.anchor.longitude, latitude: m.anchor.latitude, height: m.anchor.height };
    const matrix = buildLinearizedViewerToEcefMatrix(Cesium, anchor, lin, target);
    const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.height));
    const exactEcef = (x: number, y: number, z: number) => {
      const e = [0, 0, 0];
      m.toEnu(x, y, z, e);
      return Cesium.Matrix4.multiplyByPoint(enuToEcef, new Cesium.Cartesian3(e[0], e[1], e[2]), new Cesium.Cartesian3());
    };
    const at = (x: number, y: number, z: number) => Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
    assert.ok(Cesium.Cartesian3.distance(at(target.x, target.y, target.z), exactEcef(target.x, target.y, target.z)) < 1e-6);
    const off = Cesium.Cartesian3.distance(at(target.x + 250, target.y, target.z), exactEcef(target.x + 250, target.y, target.z));
    assert.ok(off < 0.006, `250 m from the target: ${(off * 1000).toFixed(2)} mm`);
  });
});

describe('Auto placement', () => {
  const c = PROJ_ORACLE.warp[1];
  const m = oracleMapping(c);
  const options = { projDef: c.proj4, gridCoordinates: true, geoid: () => G.n0 };
  it('keeps a 60 m building on its anchor (estimate under 1 cm)', () => {
    const e = estimateAnchorError(m, { min: { x: -30, y: 100, z: -30 }, max: { x: 30, y: 130, z: 30 } }, options);
    assert.ok(e.total < 0.01, `estimate ${e.total}`);
    assert.equal(resolveGlobePlacement('auto', e.total), 'anchor');
    assert.equal(resolveGlobePlacement('exact', e.total), 'exact');
  });
  it('places a 2 km site point by point (curvature alone is 16 cm at its corner)', () => {
    const e = estimateAnchorError(m, { min: { x: -1000, y: 100, z: -1000 }, max: { x: 1000, y: 130, z: 1000 } }, options);
    assert.ok(e.curvature > 0.15 && e.curvature < 0.16, `curvature ${e.curvature}`);
    assert.equal(resolveGlobePlacement('auto', e.total), 'exact');
    assert.equal(resolveGlobePlacement('anchor', e.total), 'anchor');
  });
});
