/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MeshData } from '@ifc-lite/geometry';
import { meshForEntity, minDistanceBetweenEntities } from './min-distance.js';

/**
 * Fixtures here are deliberately OFF-ORIGIN and, where it matters, off-axis.
 *
 * A distance routine that mishandles per-submesh origins, or that rebases
 * indices wrongly when concatenating, still passes every test whose geometry
 * sits at the world origin with one submesh per entity — the error cancels.
 * `measure-modes/radius.ts` records the same lesson from an order-dependent
 * plane that turned a 2 m arc into a 2.8 km one, so the fixtures below are
 * built to make that class of mistake visible rather than convenient.
 */

/** One triangle, as a submesh with its own local frame. */
function tri(
  expressId: number,
  verts: readonly [number, number, number][],
  origin?: [number, number, number],
  modelIndex?: number,
): MeshData {
  const positions = new Float32Array(verts.flat());
  return {
    expressId,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ...(origin ? { origin } : {}),
    ...(modelIndex === undefined ? {} : { modelIndex }),
  } as MeshData;
}

describe('meshForEntity', () => {
  it('applies each submesh its OWN origin, not the first one', () => {
    // Two submeshes of one entity, sitting 10 apart because their origins
    // differ. Using submesh 0's origin for both would stack them, and every
    // distance measured against this entity would be wrong by 10.
    const meshes = [
      tri(7, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [100, 0, 0]),
      tri(7, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [110, 0, 0]),
    ];
    const mesh = meshForEntity(meshes, 7);
    assert.ok(mesh);
    assert.equal(mesh.positions.length, 18, 'both submeshes must be present');
    // First vertex of each submesh, in world coordinates.
    assert.equal(mesh.positions[0], 100);
    assert.equal(mesh.positions[9], 110);
  });

  it('rebases indices so the second submesh addresses its own vertices', () => {
    // Without rebasing, submesh 1's indices [0,1,2] would point back at
    // submesh 0's vertices: a triangle soup that silently ignores half the
    // entity while still looking well-formed.
    const meshes = [
      tri(7, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, 0]),
      tri(7, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [50, 0, 0]),
    ];
    const mesh = meshForEntity(meshes, 7);
    assert.ok(mesh);
    assert.deepEqual([...mesh.indices], [0, 1, 2, 3, 4, 5]);
  });

  it('treats a missing origin as absolute, matching boundsFromMeshes', () => {
    const mesh = meshForEntity([tri(1, [[3, 4, 5], [4, 4, 5], [3, 5, 5]])], 1);
    assert.ok(mesh);
    assert.equal(mesh.positions[0], 3);
    assert.equal(mesh.positions[1], 4);
    assert.equal(mesh.positions[2], 5);
  });

  it('returns null for an entity with no submeshes', () => {
    assert.equal(meshForEntity([tri(1, [[0, 0, 0], [1, 0, 0], [0, 1, 0]])], 999), null);
    assert.equal(meshForEntity([], 1), null);
  });

  it('ignores degenerate submeshes that carry no triangle', () => {
    const empty = {
      ...tri(5, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
      indices: new Uint32Array([]),
    } as MeshData;
    assert.equal(meshForEntity([empty], 5), null);
  });

  it('separates entities that share an express id across federated models', () => {
    // Express ids are per-model, so a federated scene reuses them. Matching on
    // id alone would fuse two different buildings' walls into one soup.
    const meshes = [
      tri(3, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], undefined, 0),
      tri(3, [[80, 0, 0], [81, 0, 0], [80, 1, 0]], undefined, 1),
    ];
    const a = meshForEntity(meshes, 3, 0);
    const b = meshForEntity(meshes, 3, 1);
    assert.ok(a && b);
    assert.equal(a.positions.length, 9, 'model 0 must not absorb model 1');
    assert.equal(b.positions[0], 80);
    // Without a modelIndex the caller gets both, which is the documented
    // fallback rather than an accident.
    assert.equal(meshForEntity(meshes, 3)?.positions.length, 18);
  });
});

describe('minDistanceBetweenEntities', () => {
  it('measures the gap between two separated entities', () => {
    // Triangles in the z = 5 plane, well away from the origin. Nearest
    // approach is between (11,4,5) and (15,4,5), so 4.
    const meshes = [
      tri(1, [[10, 4, 5], [11, 4, 5], [10, 5, 5]]),
      tri(2, [[15, 4, 5], [16, 4, 5], [15, 5, 5]]),
    ];
    const out = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 2 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    assert.ok(Math.abs(out.distance - 4) < 1e-9, `expected 4, got ${out.distance}`);
  });

  it('accounts for the origin when it decides which submesh is nearest', () => {
    // Entity 1 has two submeshes: one far, one near. The near one is only near
    // BECAUSE of its origin. A routine that dropped origins would report the
    // distance to the far part and be wrong by an order of magnitude.
    const meshes = [
      tri(1, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, 0]),
      tri(1, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [18, 0, 0]),
      tri(2, [[20, 0, 0], [21, 0, 0], [20, 1, 0]]),
    ];
    const out = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 2 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    // Nearest is submesh 2's far corner at x = 19 against entity 2 at x = 20.
    assert.ok(Math.abs(out.distance - 1) < 1e-9, `expected 1, got ${out.distance}`);
  });

  it('reports zero for touching geometry, which is NOT the same as refusing', () => {
    // The distinction the predicate's own doc insists on: 0 means "they
    // touch", and it must be reachable and distinguishable from a refusal.
    const meshes = [
      tri(1, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
      tri(2, [[1, 0, 0], [2, 0, 0], [1, 1, 0]]),
    ];
    const out = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 2 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    assert.equal(out.distance, 0);
  });

  it('refuses rather than reporting zero when an entity has no geometry', () => {
    // The bug this type exists to prevent: `distance ?? 0` would render
    // "0.000 m" — reading as "these are touching" — for a pick that could not
    // be measured at all.
    const meshes = [tri(1, [[0, 0, 0], [1, 0, 0], [0, 1, 0]])];
    const missingB = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 42 });
    assert.equal(missingB.kind, 'refused');
    if (missingB.kind !== 'refused') return;
    assert.equal(missingB.missing, 'b');

    const missingA = minDistanceBetweenEntities(meshes, { entityId: 42 }, { entityId: 1 });
    assert.equal(missingA.kind === 'refused' && missingA.missing, 'a');

    const both = minDistanceBetweenEntities(meshes, { entityId: 42 }, { entityId: 43 });
    assert.equal(both.kind === 'refused' && both.missing, 'both');
  });

  it('gives witness points that lie on their own entity', () => {
    // The points come back in the render frame, ready for the readout without
    // a further transform. If an axis conversion crept in, these would land
    // somewhere neither entity occupies.
    const meshes = [
      tri(1, [[10, 4, 5], [11, 4, 5], [10, 5, 5]]),
      tri(2, [[15, 4, 5], [16, 4, 5], [15, 5, 5]]),
    ];
    const out = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 2 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    assert.ok(out.pointA[0] >= 10 && out.pointA[0] <= 11, `pointA.x ${out.pointA[0]}`);
    assert.ok(out.pointB[0] >= 15 && out.pointB[0] <= 16, `pointB.x ${out.pointB[0]}`);
    // Both triangles are flat in z = 5; a frame swap would move this to y.
    assert.ok(Math.abs(out.pointA[2] - 5) < 1e-9, `pointA.z ${out.pointA[2]}`);
    assert.ok(Math.abs(out.pointB[2] - 5) < 1e-9, `pointB.z ${out.pointB[2]}`);
  });

  it('is symmetric in its two arguments', () => {
    const meshes = [
      tri(1, [[10, 4, 5], [11, 4, 5], [10, 5, 5]]),
      tri(2, [[15, 4, 5], [16, 4, 5], [15, 5, 5]]),
    ];
    const ab = minDistanceBetweenEntities(meshes, { entityId: 1 }, { entityId: 2 });
    const ba = minDistanceBetweenEntities(meshes, { entityId: 2 }, { entityId: 1 });
    assert.equal(ab.kind, 'ok');
    assert.equal(ba.kind, 'ok');
    if (ab.kind !== 'ok' || ba.kind !== 'ok') return;
    assert.ok(Math.abs(ab.distance - ba.distance) < 1e-12);
  });
});
