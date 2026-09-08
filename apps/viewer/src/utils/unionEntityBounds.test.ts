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
import {
  unionEntityBounds,
  createEntityBoundsLookup,
  indexMeshesByEntity,
  boundsFromIndex,
  getEntityBounds,
  type BoundingBox3D,
} from './viewportUtils.js';

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

/** A mesh whose position buffer is too short to describe a vertex. */
function degenerateMesh(entityId: number, componentCount: number): MeshData {
  return {
    expressId: entityId,
    positions: new Float32Array(componentCount),
    normals: new Float32Array(componentCount),
    indices: new Uint32Array(0),
  } as unknown as MeshData;
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

  // #2532: more than 4 ids switches to the indexed lookup (build the
  // expressId→meshes map once instead of `.filter()`-ing the whole geometry
  // array per id — O(meshes) instead of O(ids × meshes)). These pin that the
  // indexed path aggregates identically to the unindexed one above, including
  // multi-submesh entities and ids that miss the index entirely.
  describe('the indexed path (> 4 ids)', () => {
    it('unions flat-mesh bounds identically to the unindexed path', () => {
      const geom = [mesh(1, 0), mesh(2, 10), mesh(3, 20), mesh(4, 30), mesh(5, 40)];
      const b = unionEntityBounds(geom, [1, 2, 3, 4, 5], none);
      assert.ok(b);
      assert.equal(b.min.x, 0);
      assert.equal(b.max.x, 41);
    });

    it('aggregates every submesh for an entity that has more than one', () => {
      // Two meshes sharing expressId 1 — the index must group by id, not
      // pick the first match the way a naive Map<id, MeshData> would.
      //
      // Five DISTINCT ids (1-5), not four: the indexed path only builds at
      // `ids.length > 4` (viewportUtils.ts). With four ids this test ran
      // through the unindexed `.filter()` path and stayed green even when
      // the index's `list.push(mesh)` grouping was replaced with an
      // overwriting `.set(id, [mesh])` — the multi-submesh regression this
      // test exists to catch (#2532).
      const geom = [mesh(1, 0), mesh(1, 100), mesh(2, 10), mesh(3, 20), mesh(4, 30), mesh(5, 40)];
      const b = unionEntityBounds(geom, [1, 2, 3, 4, 5], none);
      assert.ok(b);
      assert.equal(b.min.x, 0);
      assert.equal(b.max.x, 101, 'entity 1\'s second submesh (x0=100) must contribute');
    });

    it('falls back to the instanced AABB for an id the index has no mesh for', () => {
      const geom = [mesh(1, 0), mesh(2, 10), mesh(3, 20), mesh(4, 30)];
      const b = unionEntityBounds(geom, [1, 2, 3, 4, 999], (id) => (id === 999 ? box(50, 51) : null));
      assert.ok(b);
      assert.equal(b.max.x, 51, 'the instanced fallback must still apply inside the indexed path');
    });
  });
});

/**
 * The expressId index `unionEntityBounds` uses is shared with the viewport's
 * aggregation resolution (`resolveRenderableIds` in Viewport.tsx), which asks
 * about ids it discovers as it goes — one geometry-less assembly can expand to
 * hundreds of parts — and so cannot pass an id count up front. These pin the
 * shared helpers directly, because Viewport.tsx itself has no runtime harness.
 */
describe('indexMeshesByEntity', () => {
  it('groups every submesh of an entity instead of keeping only the last', () => {
    const index = indexMeshesByEntity([mesh(1, 0), mesh(2, 10), mesh(1, 100)]);
    assert.equal(index.get(1)?.length, 2, 'both submeshes of entity 1 are kept');
    assert.equal(index.get(2)?.length, 1);
  });

  it('drops meshes with a sub-vertex position buffer, as getEntityBounds does', () => {
    // `getEntityBounds` filters on `positions.length >= 3`; the index has to
    // filter identically or it starts handing `boundsFromMeshes` meshes the
    // unindexed path never saw. Asserted on the index CONTENTS, not on the
    // resulting bounds: a 0/1/2-component buffer aggregates to null either
    // way, so a bounds-level assertion here would pass with the filter
    // deleted and pin nothing at all.
    const index = indexMeshesByEntity([
      degenerateMesh(1, 0),
      degenerateMesh(2, 2),
      mesh(3, 0),
      degenerateMesh(3, 1),
    ]);
    assert.equal(index.has(1), false, 'an empty position buffer is not indexed');
    assert.equal(index.has(2), false, 'a 2-component position buffer is not indexed');
    assert.equal(index.get(3)?.length, 1, 'only entity 3\'s real mesh survives');
  });

  it('answers through boundsFromIndex exactly as getEntityBounds does', () => {
    const geom = [mesh(1, 0), mesh(1, 100), mesh(2, 10), degenerateMesh(3, 2)];
    const index = indexMeshesByEntity(geom);
    for (const id of [1, 2, 3, 999]) {
      assert.deepEqual(
        boundsFromIndex(index, id),
        getEntityBounds(geom, id),
        `indexed and unindexed bounds must agree for id ${id}`,
      );
    }
  });
});

describe('createEntityBoundsLookup', () => {
  it('answers identically across the switch to the index, without an id count', () => {
    // No `expectedLookups`: this is the viewport's aggregation case, where the
    // reader has to index itself part-way through the id stream. Every answer
    // before AND after the switch must match the unindexed function.
    const geom = [
      mesh(1, 0), mesh(2, 10), mesh(3, 20), mesh(4, 30),
      mesh(5, 40), mesh(6, 50), mesh(6, 150),
    ];
    const lookup = createEntityBoundsLookup(geom);
    for (const id of [1, 2, 3, 4, 5, 6, 999]) {
      assert.deepEqual(lookup(id), getEntityBounds(geom, id), `id ${id}`);
    }
  });

  it('still aggregates every submesh for an id first asked AFTER it indexes', () => {
    // What decides the path is the number of LOOKUPS already made, not where
    // the id sits in the mesh array. Entity 6 being the sixth entity buys
    // nothing: asked first, it is answered by the unindexed scan like any
    // other first lookup. So drain past INDEX_AFTER_LOOKUPS with ids 1..5
    // FIRST, and only then ask for 6, which is the only way this reaches the
    // indexed path at all. Without the drain this test passes identically
    // against a lookup that never indexes — it would be named for a path it
    // never takes, and the multi-submesh grouping regression (#2532) would
    // stay caught only on the count-driven path.
    const geom = [
      mesh(1, 0), mesh(2, 10), mesh(3, 20), mesh(4, 30), mesh(5, 40),
      mesh(6, 50), mesh(6, 150),
    ];
    const lookup = createEntityBoundsLookup(geom);
    for (const id of [1, 2, 3, 4, 5]) assert.ok(lookup(id), `warm-up id ${id}`);
    const b = lookup(6);
    assert.ok(b);
    assert.equal(b.min.x, 50);
    assert.equal(b.max.x, 151, 'entity 6\'s second submesh must contribute');
  });

  it('returns null for every id once geometry has been released', () => {
    const lookup = createEntityBoundsLookup(null);
    for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(lookup(id), null);
  });
});
