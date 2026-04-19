/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MeshData } from '@ifc-lite/geometry';
import { meshPlaneRelation, subtractHalfspace } from './index.ts';

/**
 * Build a trivial MeshData from a flat list of vertex triples. Tests only
 * use `positions`; other fields are stubbed.
 */
function mesh(positions: number[]): MeshData {
  return {
    positions: new Float32Array(positions),
    normals:   new Float32Array(positions.length),
    indices:   new Uint32Array(positions.length / 3),
    color:     [1, 1, 1, 1],
    expressId: 0,
  };
}

describe('meshPlaneRelation', () => {
  it('reports kept when all vertices are below the plane', () => {
    // Plane: y = 5 (normal pointing up, points ABOVE the plane are removed).
    const m = mesh([0, 0, 0, 1, 1, 0, 2, 2, 0]);
    const r = meshPlaneRelation(m, { normal: [0, 1, 0], distance: 5 }, 1e-6);
    assert.strictEqual(r, 'kept');
  });

  it('reports dropped when all vertices are above the plane', () => {
    const m = mesh([0, 10, 0, 1, 11, 0, 2, 12, 0]);
    const r = meshPlaneRelation(m, { normal: [0, 1, 0], distance: 5 }, 1e-6);
    assert.strictEqual(r, 'dropped');
  });

  it('reports straddle when vertices fall on both sides of the plane', () => {
    const m = mesh([0, 0, 0, 1, 10, 0, 2, 2, 0]);
    const r = meshPlaneRelation(m, { normal: [0, 1, 0], distance: 5 }, 1e-6);
    assert.strictEqual(r, 'straddle');
  });
});

describe('subtractHalfspace fast path', () => {
  it('returns kept meshes untouched without loading manifold-3d', async () => {
    const keep = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const res = await subtractHalfspace([keep], { normal: [0, 1, 0], distance: 5 });
    assert.strictEqual(res.meshes.length, 1);
    assert.strictEqual(res.meshes[0], keep);
    assert.strictEqual(res.stats.kept, 1);
    assert.strictEqual(res.stats.dropped, 0);
    assert.strictEqual(res.stats.clipped, 0);
  });

  it('drops meshes entirely above the plane', async () => {
    const drop = mesh([0, 10, 0, 1, 11, 0, 2, 12, 0]);
    const res = await subtractHalfspace([drop], { normal: [0, 1, 0], distance: 5 });
    assert.strictEqual(res.meshes.length, 0);
    assert.strictEqual(res.stats.dropped, 1);
  });
});
