/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Exact globe placement's GLB bake against PROJ: the oracle's 20 km line
 * (`__fixtures__/proj-oracle.json`, `warp`) as one small triangle every
 * 500 m, baked into float32 tiles, read back from the GLB bytes and compared
 * with PROJ's ECEF. Normals are compared with PROJ's meridian convergence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MeshData } from '@ifc-lite/geometry';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { enuFrameAt } from './geo-ecef.js';
import { bakeGlobeTiles, GLOBE_TILE_M } from './globe-glb.js';
import { buildMergedGLB } from './cesium-glb.js';
import { dist, ecefOf, gridViewer, rigidMapping } from '@/test/geo-warp-fixture.js';

/** The GLB's single node, its positions and normals (both accessors are float32 VEC3, positions first). */
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

describe('Exact GLB bake vs PROJ', () => {
  // UTM 32N at 11.9°E, 2.9° east of the central meridian: convergence and scale are far from trivial.
  const c = PROJ_ORACLE.warp[1];
  const m = rigidMapping(c);
  const truth = c.points.filter((p) => p.H === 100);
  // One small triangle per oracle point, its first vertex on the point, with a +x normal (a wall facing grid east).
  const meshes: MeshData[] = truth.map((p, i) => ({
    expressId: i + 1,
    positions: new Float32Array([0, 0, 0, 0, 3, 0, 0, 0, -2]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [...gridViewer(p)],
  }) as MeshData);

  it('lands every vertex within 1 mm of PROJ through float32 tiles of at most 2 km', () => {
    const tiles = bakeGlobeTiles(meshes, m);
    assert.ok(tiles && tiles.length > 1, 'a 20 km line spans several tiles');
    const frame = enuFrameAt(m.anchor.latitude, m.anchor.longitude, m.anchor.height);
    let worst = 0;
    let checked = 0;
    for (const tile of tiles) {
      const { node, positions } = readGlb(buildMergedGLB(tile.meshes, tile.translation));
      assert.deepEqual(node.translation, tile.translation);
      tile.meshes.forEach((mesh, k) => {
        const at = k * 9; // the first vertex is the oracle point
        const enu = [0, 1, 2].map((i) => positions[at + i] + node.translation[i]);
        worst = Math.max(worst, dist(ecefOf(frame, enu), truth[mesh.expressId - 1].ecef));
        // Float32 needs the tile-relative magnitude small: within a tile's half-diagonal.
        assert.ok(Math.hypot(positions[at], positions[at + 1]) <= GLOBE_TILE_M * Math.SQRT1_2 + 1);
        checked++;
      });
    }
    assert.equal(checked, truth.length);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
  });

  it('rotates normals into ENU: a grid-east wall faces true east turned by the convergence', () => {
    const middle = truth.findIndex((p) => p.dE === 0 && p.dN === 0);
    assert.ok(middle >= 0, 'the oracle line passes through its anchor');
    const tiles = bakeGlobeTiles([meshes[middle]], m);
    assert.ok(tiles);
    const { normals } = readGlb(buildMergedGLB(tiles[0].meshes, tiles[0].translation));
    const n = [normals[0], normals[1], normals[2]];
    assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-6);
    // PROJ at 11.9°E 50°N (`cases[0]`): grid east is 0.0388 rad from true east.
    const pinned = PROJ_ORACLE.cases[0].points[1];
    assert.equal(pinned.lon, c.anchor.lon);
    assert.ok(Math.abs(Math.atan2(n[1], n[0]) - pinned.gammaTrueNorth) < 2e-4, `normal bearing ${Math.atan2(n[1], n[0])}`);
    assert.ok(Math.abs(n[2]) < 2e-3, 'stays horizontal to the local tilt');
  });

  it('refuses a model the projection cannot place instead of baking part of it', () => {
    const far = { ...meshes[0], origin: [4e7, 100, 0] as [number, number, number] };
    assert.equal(bakeGlobeTiles([meshes[0], far], m), null);
  });
});
