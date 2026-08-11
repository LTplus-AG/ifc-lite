/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Scene } from './scene.js';
import { worldAabbFromPieces } from './scene-geometry.js';
import { raycastTriangles, prepareRayDirInv, type BoundingBox } from './scene-raycaster.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * #2480 — `Scene.getEntityBoundingBox` computed AND cached the inverted-empty
 * sentinel `{ min: +Infinity, max: -Infinity }` for a piece with a zero-length
 * positions array.
 *
 * Two separate things were wrong, and they need separating because the
 * sentinel is a legitimate value in one place and never a legitimate one here:
 *
 *  - as the SEED of a min/max accumulation it is exactly right, and
 *    `ModelBoundsTracker` still relies on that (its own tests pin it);
 *  - as an ANSWER it is not a box, and `getEntityBoundingBox` handed it to
 *    raycasting, rectangle select, zone/clash assignment and the BCF marker
 *    placement, all of which read `min`/`max` as coordinates.
 *
 * Caching it was the sharper half: a transient empty piece poisoned the entry
 * for an entity that later gained real geometry, and this cache has no
 * invalidation tied to a later `addMeshData`.
 *
 * `Scene.getBounds()` — the sibling accumulation over the same `meshDataMap` —
 * has always screened each vertex with `Number.isFinite` and returned `null`
 * when none survived, so the per-entity path is now brought in line with the
 * whole-scene one rather than given a new contract.
 */

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeDevice(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(desc.size);
      return {
        size: desc.size,
        getMappedRange: () => backing,
        unmap() {},
        destroy() {},
      };
    },
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}

function mesh(
  expressId: number,
  positions: number[],
  origin?: [number, number, number],
): MeshData {
  const p = new Float32Array(positions);
  return {
    expressId,
    positions: p,
    normals: new Float32Array(p.length),
    indices: new Uint32Array(p.length / 3 >= 3 ? [0, 1, 2] : []),
    color: [1, 1, 1, 1],
    ...(origin ? { origin } : {}),
  } as unknown as MeshData;
}

/** A unit triangle sitting at the origin, big enough for a ray to hit. */
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0];

describe('worldAabbFromPieces (#2480)', () => {
  it('returns null — not the inverted-empty sentinel — for a zero-length positions array', () => {
    assert.strictEqual(worldAabbFromPieces([{ positions: new Float32Array([]) }]), null);
  });

  it('returns null for no pieces at all, and for undefined', () => {
    assert.strictEqual(worldAabbFromPieces([]), null);
    assert.strictEqual(worldAabbFromPieces(undefined), null);
  });

  it('returns null when every vertex is non-finite', () => {
    assert.strictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([NaN, NaN, NaN]) }]),
      null,
    );
    assert.strictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([Infinity, 0, 0, -Infinity, 0, 0]) }]),
      null,
      'an infinite vertex is skipped, not folded into the box',
    );
  });

  it('skips a non-finite vertex but keeps the box the finite ones describe', () => {
    // #1645 records NaN placement matrices as a real input class. One infinite
    // coordinate must not widen the entity to infinity and hand that to the
    // camera, raycaster and clash consumers.
    assert.deepStrictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([1, 1, 1, Infinity, 5, 5, NaN, 2, 2]) }]),
      { min: { x: 1, y: 1, z: 1 }, max: { x: 1, y: 1, z: 1 } },
    );
  });

  it('unions across pieces, so one empty piece does not erase a real one', () => {
    assert.deepStrictEqual(
      worldAabbFromPieces([
        { positions: new Float32Array([]) },
        { positions: new Float32Array([0, 0, 0, 1, 2, 3]) },
        { positions: new Float32Array([]) },
      ]),
      { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
    );
  });

  it('folds the per-element local-frame origin into world space', () => {
    assert.deepStrictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([0, 0, 0, 1, 1, 1]), origin: [10, 20, 30] }]),
      { min: { x: 10, y: 20, z: 30 }, max: { x: 11, y: 21, z: 31 } },
    );
  });

  it('ignores a trailing partial vertex rather than reading undefined as NaN', () => {
    assert.deepStrictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([1, 2, 3, 4, 5]) }]),
      { min: { x: 1, y: 2, z: 3 }, max: { x: 1, y: 2, z: 3 } },
    );
  });

  // Anti-mutation: the guard is a finiteness test, not a magnitude one. A
  // plausible-looking over-broad "sanity bound" (`Math.abs(x) < 1e8 -> skip`)
  // would pass every rejection case above and quietly delete real buildings:
  // a georeferenced model authored in millimetres sits around 1e9, which is
  // exactly why #1114's f32-collapse work exists.
  it('still accepts a legitimately huge but finite coordinate', () => {
    const box = worldAabbFromPieces([{ positions: new Float32Array([2.6e9, -1.2e9, 5e8, 0, 0, 0]) }]);
    assert.ok(box, 'a millimetre-authored georeferenced model is not degenerate');
    // Float32 rounding, hence fround rather than the literal.
    assert.strictEqual(box!.max.x, Math.fround(2.6e9));
    assert.strictEqual(box!.min.y, Math.fround(-1.2e9));
  });

  it('still accepts a zero-extent (single-point) entity', () => {
    assert.deepStrictEqual(
      worldAabbFromPieces([{ positions: new Float32Array([7, 7, 7]) }]),
      { min: { x: 7, y: 7, z: 7 }, max: { x: 7, y: 7, z: 7 } },
    );
  });
});

describe('Scene.getEntityBoundingBox does not cache "no geometry yet" (#2480)', () => {
  it('returns null for an entity whose only piece has zero-length positions', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    assert.strictEqual(scene.getEntityBoundingBox(10), null);
  });

  it('THE CACHE BUG: an entity that later gains real geometry gets its real box', () => {
    // The sharp half of the issue. Before the fix, the first call cached
    // {min:+Infinity, max:-Infinity} and every later call returned it, because
    // nothing invalidates this cache when `addMeshData` adds a piece.
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    assert.strictEqual(scene.getEntityBoundingBox(10), null, 'nothing to box yet');

    scene.addMeshData(mesh(10, [0, 0, 0, 1, 2, 3]));
    assert.deepStrictEqual(
      scene.getEntityBoundingBox(10),
      { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
      'the transient empty piece must not have poisoned the entry',
    );
  });

  it('still memoises a real box (the same object identity on a second call)', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(10, TRI));
    const first = scene.getEntityBoundingBox(10);
    assert.ok(first);
    assert.strictEqual(scene.getEntityBoundingBox(10), first, 'caching is not disabled wholesale');
  });

  it('agrees with Scene.getBounds(), its sibling accumulation over the same map', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    assert.strictEqual(scene.getBounds(), null);
    assert.strictEqual(scene.getEntityBoundingBox(10), null, 'the two paths must not disagree');
  });
});

describe('#2480 consumers: what the sentinel used to reach', () => {
  it('raycast: an empty entity is skipped, and its neighbour is still hit', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    scene.addMeshData(mesh(11, TRI));
    const origin = { x: 0.25, y: 0.25, z: 5 };
    const dir = { x: 0, y: 0, z: -1 };
    const { rayDirInv, rayDirSign } = prepareRayDirInv(dir);
    const map = (scene as unknown as { meshDataMap: Map<number, never[]> }).meshDataMap;
    const hit = raycastTriangles(
      origin, dir, rayDirInv, rayDirSign,
      map as never,
      (id: number) => scene.getEntityBoundingBox(id) as BoundingBox | null,
    );
    assert.ok(hit, 'the real triangle must still be pickable');
    assert.strictEqual(hit!.expressId, 11);
  });

  it('rectangle select: an empty entity is never returned', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    scene.addMeshData(mesh(11, TRI));
    // Identity view-projection: clip space == world space, so the unit
    // triangle at the origin lands mid-canvas and the whole rect covers it.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const picked = scene.selectRect(0, 0, 800, 600, 800, 600, identity);
    assert.ok(picked.has(11), 'sanity: the real entity is inside the rect');
    assert.ok(!picked.has(10), 'an entity with no geometry must not be selectable');
  });

  it('zone/clash-style enumeration: no entity reports an inverted-empty AABB', () => {
    // The shape `useZoneAssignmentSync.gatherElementBounds` uses — walk every
    // id and keep whatever box comes back. It skips `null`, so producing null
    // is what keeps a garbage element out of the assignment engine.
    const scene = new Scene();
    scene.addMeshData(mesh(10, []));
    scene.addMeshData(mesh(11, TRI));
    const gathered = scene.getAllMeshDataExpressIds()
      .map((id) => [id, scene.getEntityBoundingBox(id)] as const)
      .filter((e): e is readonly [number, BoundingBox] => e[1] !== null);
    assert.deepStrictEqual(gathered.map(([id]) => id), [11]);
    for (const [, b] of gathered) {
      for (const v of [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]) {
        assert.ok(Number.isFinite(v), `non-finite bound reached a consumer: ${v}`);
      }
    }
  });

  it('the instanced union still works without a cached sentinel to fold into', () => {
    // The one place the inverted-empty box IS the correct identity:
    // `unionInstancedWorldAabb` reads the cached entry as an accumulator. With
    // no entry it takes its `else` branch and stores the occurrence box
    // outright, which is the same answer — this pins that equivalence.
    const scene = new Scene();
    scene.addMeshData(mesh(42, []));           // would have cached the sentinel
    assert.strictEqual(scene.getEntityBoundingBox(42), null);
    scene.addInstancedShard(fakeDevice(), {
      templates: [{
        positions: new Float32Array(TRI),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
        origin: [0, 0, 0] as [number, number, number],
      }],
      instances: [{
        templateIndex: 0,
        entityId: 42,
        color: [1, 1, 1, 1] as [number, number, number, number],
        transform: new Float32Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      }],
    }, 0);
    const box = scene.getEntityBoundingBox(42)!;
    assert.ok(box, 'the occurrence box must be published');
    assert.strictEqual(box.min.x, 5, 'and it must be the occurrence box, not a union with Infinity');
    assert.strictEqual(box.max.x, 6);
  });

  it('geometry release publishes no id for a geometry-less entity', () => {
    // Post-release the keys of `boundingBoxes` ARE the authoritative id set,
    // so a cached sentinel here published a garbage entity to every CPU
    // consumer — and made the released `getBounds()` return the sentinel as
    // the scene box while the pre-release path returned null for the same data.
    const scene = new Scene();
    scene.addMeshData(mesh(40, []));
    assert.strictEqual(scene.getBounds(), null, 'pre-release answer');
    scene.releaseGeometryData();
    assert.deepStrictEqual(scene.getAllMeshDataExpressIds(), []);
    assert.strictEqual(scene.getEntityBoundingBox(40), null);
    assert.strictEqual(scene.getBounds(), null, 'the two paths must still agree after release');
  });

  it('geometry release still publishes ids that DO have geometry', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(40, []));
    scene.addMeshData(mesh(41, TRI));
    scene.releaseGeometryData();
    assert.deepStrictEqual(scene.getAllMeshDataExpressIds(), [41]);
    assert.ok(scene.getEntityBoundingBox(41), 'the release path must not have become a no-op');
  });
});
