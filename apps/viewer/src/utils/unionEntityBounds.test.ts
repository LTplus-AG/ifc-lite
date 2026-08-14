/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `unionEntityBounds` — the aggregation behind `Viewport.frameEntities`, which the
 * Space Sketch tool calls to frame a storey's spaces.
 *
 * The case that matters and that a `!geometry` early-return silently killed: GPU-
 * instanced occurrences are not in `geometryResult.meshes`, and after streaming
 * releases the mesh arrays `geometry` is null outright. The renderer scene is then
 * the ONLY source of bounds, so a null `geometry` must still resolve through
 * `instancedBounds` rather than abort the frame.
 *
 * Extracted to `viewportUtils` so this is provable without a WebGL context.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { unionEntityBounds, type BoundingBox3D } from './viewportUtils.js';

/** A one-triangle mesh for `entityId`, spanning [x0,x0+1] on each axis. */
function mesh(entityId: number, x0: number): MeshData {
  return {
    expressId: entityId,
    positions: new Float32Array([x0, x0, x0, x0 + 1, x0, x0, x0, x0 + 1, x0 + 1]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
  } as unknown as MeshData;
}

function box(lo: number, hi: number): BoundingBox3D {
  return { min: { x: lo, y: lo, z: lo }, max: { x: hi, y: hi, z: hi } };
}

const none = () => null;

describe('unionEntityBounds', () => {
  it('unions the flat-mesh bounds of several entities', () => {
    const geom = [mesh(1, 0), mesh(2, 10)];
    const b = unionEntityBounds(geom, [1, 2], none);
    assert.ok(b);
    assert.equal(b.min.x, 0);
    assert.equal(b.max.x, 11);
  });

  it('falls back to the instanced AABB for an id with no flat mesh', () => {
    const b = unionEntityBounds([mesh(1, 0)], [1, 7], (id) => (id === 7 ? box(20, 22) : null));
    assert.ok(b);
    assert.equal(b.min.x, 0, 'flat mesh still contributes');
    assert.equal(b.max.x, 22, 'and so does the instanced occurrence');
  });

  it('resolves through the instanced AABB when geometry is null (released after streaming)', () => {
    // RED before the fix: `frameEntities` returned on `!geom` before reaching the
    // fallback, so framing an instanced entity did nothing at all once the mesh
    // arrays were released — the exact state Space Sketch frames a storey in.
    const b = unionEntityBounds(null, [7, 8], (id) => (id === 7 ? box(1, 2) : box(5, 6)));
    assert.ok(b, 'a null geometry must not abort the frame');
    assert.equal(b.min.x, 1);
    assert.equal(b.max.x, 6);
  });

  it('returns null when nothing resolves, so the caller can skip the camera move', () => {
    assert.equal(unionEntityBounds(null, [1, 2], none), null);
    assert.equal(unionEntityBounds([mesh(1, 0)], [], none), null);
  });

  it('skips unresolvable ids instead of poisoning the union with Infinity', () => {
    // Bounding control: if a missing id contributed a sentinel rather than being
    // skipped, the union would blow out and the camera would frame the universe.
    const b = unionEntityBounds([mesh(1, 0)], [1, 999], none);
    assert.ok(b);
    assert.equal(b.min.x, 0);
    assert.equal(b.max.x, 1);
  });

  it('tolerates an instancedBounds that returns undefined, not just null', () => {
    // `scene?.getInstancedEntityBounds(id)` yields undefined when the scene itself
    // is absent — a distinct falsy value from the null the mesh lookup returns.
    const b = unionEntityBounds(null, [7], () => undefined);
    assert.equal(b, null);
  });
});
