/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A pick reports the `IfcRepresentationItem` it hit, not just the owning
 * product (#2985).
 *
 * Every case runs on BOTH pick paths, and asserts which one it took. `pick()`
 * takes the GPU route only while hydrating an individual mesh per visible piece
 * stays under `MAX_PICK_MESH_CREATION` (500); every model bigger than that
 * falls to `Scene.raycast`. A fix that reached only the GPU path would pass a
 * GPU-only test and stay product-level on the common case, and the caller could
 * not tell that from geometry that genuinely has no item identity — both look
 * like a valid PickResult with no id. The over-budget half is the load-bearing
 * one, and the two answering DIFFERENTLY for one click is the failure the
 * merged-piece case pins down.
 *
 * Fixture values are deliberately all different (product 7001, item 4638,
 * material 99, model 3) so a mis-wiring that reports the product or the
 * material cannot pass.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PickingManager } from './picking-manager.js';
import { resolvePickSample, reportableItemId } from './pick-resolve.js';
import { decodePickSample } from './point-picker.js';
import { Scene } from './scene.js';
import { prepareRayDirInv, raycastTriangles, type BoundingBox } from './scene-raycaster.js';
import type { Mesh } from './types.js';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';

// WebGPU enum globals Scene's instanced upload reads (not defined in node) —
// the same stub the other renderer tests install.
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const PRODUCT = 7001;   // the IfcWindow a naive pick collapses to
const ITEM = 4638;      // the IfcRepresentationItem we want back
const MATERIAL = 99;    // the disjoint materialId, which must never be reported
const NEIGHBOUR = 7002; // a second entity sharing one colour-merged piece
const MODEL = 3;

/** A unit triangle in the z = -5 plane, straight ahead of a ray down -Z. */
function triangle(extra: Partial<MeshData> = {}): MeshData {
  return {
    expressId: PRODUCT,
    positions: new Float32Array([-1, -1, -5, 1, -1, -5, 0, 1, -5]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    modelIndex: MODEL,
    ...extra,
  } as MeshData;
}

/** The same triangle at an arbitrary depth, so two hits can be ordered. */
function triangleAt(z: number, extra: Partial<MeshData> = {}): MeshData {
  return triangle({ positions: new Float32Array([-1, -1, z, 1, -1, z, 0, 1, z]), ...extra });
}

const BBOX: BoundingBox = { min: { x: -1, y: -1, z: -5 }, max: { x: 1, y: 1, z: -5 } };
const RAY_ORIGIN = { x: 0, y: 0, z: 0 };
const RAY_DIR = { x: 0, y: 0, z: -1 };

function hydrate(piece: MeshData): Mesh {
  // Stands in for Renderer.createMeshFromData, which needs a live GPUDevice.
  // It copies exactly the identity fields that method copies, including the
  // SAME shared `reportableItemId` rule — a stand-in that decided this for
  // itself would prove nothing about the route it stands in for. That method's
  // own call is covered against a real device in renderer-render-paths.test.ts.
  return {
    expressId: piece.expressId,
    modelIndex: piece.modelIndex,
    geometryItemId: reportableItemId(piece, piece.expressId),
  } as Mesh;
}

/**
 * A PickingManager wired to `pieceCount` batched pieces. Under 500 it takes the
 * GPU route (hydrate + picker); over 500 `prepareBatchedPick` returns 'cpu' and
 * the manager raycasts instead. The picker stub stands in for the GPU readback
 * ONLY — the decision of what a sample means is the real `resolvePickSample`,
 * and the CPU hit is the real `raycastTriangles`.
 */
function makeManager(piece: MeshData, pieceCount: number) {
  const hydrated: Mesh[] = [];
  const calls = { picker: 0, raycast: 0 };
  const meshDataMap = new Map<number, MeshData[]>([[PRODUCT, [piece]]]);
  // Filler ids pad the model past the pick-mesh budget; they own no geometry
  // the ray can hit, so the hit is always `piece`.
  const fillerIds = Array.from({ length: pieceCount - 1 }, (_, i) => 900_000 + i);
  for (const id of fillerIds) meshDataMap.set(id, [{ ...piece, expressId: id } as MeshData]);

  const camera = {
    unprojectToRay: () => ({ origin: RAY_ORIGIN, direction: RAY_DIR }),
    getViewProjMatrix: () => ({ m: new Float32Array(16) }),
  };

  const scene = {
    getMeshes: () => hydrated,
    getBatchedMeshes: () => [{ expressIds: [PRODUCT] }],
    isGeometryDataReleased: () => false,
    getAllMeshDataExpressIds: () => [...meshDataMap.keys()],
    getMeshDataPieces: (expressId: number) => meshDataMap.get(expressId),
    getInstancedTemplates: () => undefined,
    raycast: () => {
      calls.raycast += 1;
      const { rayDirInv, rayDirSign } = prepareRayDirInv(RAY_DIR);
      return raycastTriangles(
        RAY_ORIGIN, RAY_DIR, rayDirInv, rayDirSign, meshDataMap,
        (id) => (id === PRODUCT ? BBOX : null),
      );
    },
  };

  const picker = {
    pick: async (
      _x: number, _y: number, _w: number, _h: number, meshes: Mesh[],
    ) => {
      calls.picker += 1;
      const index = meshes.findIndex((m) => m.expressId === PRODUCT);
      if (index < 0) return null;
      // A mesh sample is (index + 1) written into the r32uint pick target.
      return resolvePickSample(decodePickSample(index + 1), meshes, undefined, null);
    },
  };

  const canvas = {
    width: 100,
    height: 100,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  };

  const manager = new PickingManager(
    camera as never,
    scene as never,
    picker as never,
    canvas as HTMLCanvasElement,
    (p) => hydrated.push(hydrate(p)),
  );
  return { manager, calls };
}

/** Which route a pick took. Asserted everywhere, because a "CPU" test that
 *  quietly went down the GPU route would prove nothing about the fallback. */
function assertRoute(calls: { picker: number; raycast: number }, route: 'GPU' | 'CPU'): void {
  assert.equal(calls.picker, route === 'GPU' ? 1 : 0, `expected the ${route} route`);
  assert.equal(calls.raycast, route === 'CPU' ? 1 : 0, `expected the ${route} route`);
}

describe('pick reports the representation item (#2985)', () => {
  // 1 piece stays under MAX_PICK_MESH_CREATION (500) and takes the GPU route;
  // 900 is over it, so prepareBatchedPick falls to Scene.raycast. Every case
  // runs BOTH, because a fix on one route alone is exactly the failure mode.
  for (const [label, count] of [['GPU', 1], ['CPU', 900]] as const) {
    it(`${label} path: the item id comes back, and is not the product or the material id`, async () => {
      const { manager, calls } = makeManager(triangle({ geometryItemId: ITEM, materialId: MATERIAL }), count);
      const result = await manager.pick(50, 50);
      assertRoute(calls, label);
      assert.equal(result?.expressId, PRODUCT);
      assert.equal(result?.geometryItemId, ITEM, 'the pick collapsed to the product');
      assert.notEqual(result?.geometryItemId, PRODUCT);
      assert.notEqual(result?.geometryItemId, MATERIAL);
      assert.equal(result?.modelIndex, MODEL);
    });

    it(`${label} path: a piece with no item identity leaves the key ABSENT`, async () => {
      const { manager, calls } = makeManager(triangle(), count);
      const result = await manager.pick(50, 50);
      assertRoute(calls, label);
      assert.equal(result?.expressId, PRODUCT);
      // Absent, not 0 and not present-but-undefined: a host reading
      // `'geometryItemId' in result` must be able to tell "no item here" from
      // an item whose id happens to be falsy.
      assert.ok(result && !('geometryItemId' in result), 'expected the key to be absent');
      assert.notEqual(result?.geometryItemId, 0);
    });

    it(`${label} path: a colour-merged piece reports no item id for any of its entities`, async () => {
      // Genuinely merged: the piece's three vertices belong to TWO entities, so
      // whatever item id it carries describes neither of them individually.
      // Vertex 0 is PRODUCT, which is what the raycaster's per-triangle entity
      // filter reads, so the ray still hits.
      //
      // The CPU route is where a real Scene hands out a raw merged piece: it
      // raycasts `meshDataMap` directly. The GPU route in production would go
      // through Scene.getMeshDataPieces first, which splits merged pieces per
      // entity; the stub here does not, so this pins the shared rule on both
      // routes rather than claiming the real GPU route sees merged geometry.
      const merged = triangle({
        geometryItemId: ITEM,
        entityIds: new Uint32Array([PRODUCT, NEIGHBOUR, NEIGHBOUR]),
      });
      const { manager, calls } = makeManager(merged, count);
      const result = await manager.pick(50, 50);
      assertRoute(calls, label);
      assert.equal(result?.expressId, PRODUCT);
      assert.ok(result && !('geometryItemId' in result), 'a merged batch id must not be attributed');
    });

    it(`${label} path: an authored single-entity piece reports its item id despite carrying entityIds`, async () => {
      // The counter-case to the one above, and the reason the rule scans for a
      // FOREIGN id instead of testing whether `entityIds` exists at all: an
      // element authored in-session tags EVERY vertex with its own id so
      // picking can find it. All-same-id attributes unambiguously, so
      // withholding here would be a false negative a host cannot tell from "no
      // item on this geometry". `Scene.translateFlatMeshesForEntity` already
      // draws the line this way, having first drawn it the other way and frozen
      // authored elements under the gizmo.
      const authored = triangle({
        geometryItemId: ITEM,
        entityIds: new Uint32Array([PRODUCT, PRODUCT, PRODUCT]),
      });
      const { manager, calls } = makeManager(authored, count);
      const result = await manager.pick(50, 50);
      assertRoute(calls, label);
      assert.equal(result?.expressId, PRODUCT);
      assert.equal(result?.geometryItemId, ITEM, 'an all-same-id piece is not a merge');
    });
  }

  it('an instanced occurrence reports no item id, and says so by absence', () => {
    // Lane A territory: the instanced pick shader writes the express id straight
    // into the sample, so there is no per-occurrence item channel to read.
    // INSTANCED_PICK_MARKER (bit 30) | expressId.
    const decoded = decodePickSample(0x40000000 | PRODUCT);
    assert.equal(decoded.kind, 'instanced');
    const result = resolvePickSample(decoded, [], undefined, null);
    assert.equal(result?.expressId, PRODUCT);
    assert.ok(result && !('geometryItemId' in result));
  });
});

/**
 * `Scene.raycast` is the CPU route's OWN forwarding step, and until now nothing
 * ran it: the cases above stub `scene.raycast` and drive `raycastTriangles`
 * directly, so the one function that has to carry `geometryItemId` off a
 * `RaycastHit` and out of the Scene was never executed by a test.
 *
 * That is a silent gap, not a loud one. Rewriting the tail as
 * `return normalise(flatHit ?? instancedHit)` — the shape a "give the two
 * branches one exit" refactor produces — rebuilds the hit as
 * `{ expressId, distance, modelIndex }` and drops the field, and the whole
 * renderer suite stayed green. What ships from that is every model over
 * MAX_PICK_MESH_CREATION silently back at product level, which is exactly the
 * failure #2985 exists to prevent and which a host cannot tell from geometry
 * that genuinely has no item identity.
 *
 * So these run the REAL Scene: real `addMeshData` / `addInstancedShard`, real
 * bounding-box cache, real `Scene.raycast`. Both of its branches, and the
 * closest-of-two comparison between them in both directions, because that
 * comparison is a second place a rebuild could land.
 */
describe('Scene.raycast itself forwards the item id (#2985)', () => {
  const INSTANCED = 7003; // an instanced-only occurrence, absent from meshDataMap

  /** `addInstancedShard` only asks the device for sized, mapped buffers, so a
   *  stub runs the real interleave / bounds-fold / entity-map code. */
  function fakeDevice(): GPUDevice {
    return {
      limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createBuffer: (desc: { size: number }) => {
        const backing = new ArrayBuffer(desc.size);
        return { size: desc.size, getMappedRange: () => backing, unmap() {}, destroy() {} };
      },
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
  }

  /**
   * One occurrence of the SAME fixture triangle, at `z` in world space.
   *
   * Written in IFC Z-up, because a shard is decoder output: the upload converts
   * to the viewer's Y-up ((x, y, z) -> (x, z, -y)) and applies it to template
   * vertices and occurrence translation alike. The Z-up preimages below come
   * back out of `getInstancedMeshDataPieces` as exactly `triangleAt(z)`, so the
   * flat and instanced branches are compared on identical geometry.
   */
  function instancedShardAt(z: number): DecodedInstancedShard {
    return {
      // #2985 landed a required flag on the decoded shard: false says the
      // encoder wrote a base-stride record, so no occurrence here names an
      // item. This fixture exercises the express-id half of the instanced CPU
      // route; the item-id half is pinned on the instancing side.
      carriesItemIds: false,
      templates: [{
        positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]),
        normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        origin: [0, 0, 0] as [number, number, number],
      }],
      instances: [{
        templateIndex: 0,
        entityId: INSTANCED,
        color: [1, 1, 1, 1] as [number, number, number, number],
        // Row-major (translation in the last column), Z-up (0, -z, 0), which
        // converts to the Y-up (0, 0, z) the ray is aimed down.
        transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, -z, 0, 0, 1, 0, 0, 0, 0, 1]),
      }],
    };
  }

  it('flat branch: a hit carries its geometryItemId out of Scene.raycast', () => {
    const scene = new Scene();
    scene.addMeshData(triangle({ geometryItemId: ITEM, materialId: MATERIAL }));

    const hit = scene.raycast(RAY_ORIGIN, RAY_DIR);
    assert.equal(hit?.expressId, PRODUCT);
    assert.equal(hit?.geometryItemId, ITEM, 'Scene.raycast dropped the item id');
    assert.notEqual(hit?.geometryItemId, PRODUCT);
    assert.notEqual(hit?.geometryItemId, MATERIAL);
    assert.equal(hit?.modelIndex, MODEL);
  });

  it('flat branch: a piece with no item identity comes back undefined, not 0', () => {
    const scene = new Scene();
    scene.addMeshData(triangle());

    const hit = scene.raycast(RAY_ORIGIN, RAY_DIR);
    assert.equal(hit?.expressId, PRODUCT);
    assert.equal(hit?.geometryItemId, undefined);
  });

  it('instanced branch: an occurrence is hit and reports no item id', () => {
    const scene = new Scene();
    scene.addInstancedShard(fakeDevice(), instancedShardAt(-5), MODEL);

    const hit = scene.raycast(RAY_ORIGIN, RAY_DIR);
    // The branch really ran: this id lives only in the instanced shard.
    assert.equal(hit?.expressId, INSTANCED, 'the instanced branch did not produce the hit');
    // Absent by construction, not by accident: getInstancedMeshDataPieces
    // synthesises MeshData from a shared template that holds no per-occurrence
    // item identity. Fixing the instanced pick shader does not change this.
    assert.equal(hit?.geometryItemId, undefined);
  });

  it('closest-of-two: the nearer FLAT hit wins and keeps its item id', () => {
    const scene = new Scene();
    scene.addMeshData(triangleAt(-5, { geometryItemId: ITEM }));   // t = 5
    scene.addInstancedShard(fakeDevice(), instancedShardAt(-9), MODEL); // t = 9

    const hit = scene.raycast(RAY_ORIGIN, RAY_DIR);
    assert.equal(hit?.expressId, PRODUCT, 'the nearer flat hit must win');
    assert.equal(hit?.geometryItemId, ITEM, 'the comparison dropped the item id');
  });

  it('closest-of-two: a nearer INSTANCED hit wins, and still reports no item id', () => {
    const scene = new Scene();
    scene.addMeshData(triangleAt(-5, { geometryItemId: ITEM }));   // t = 5
    scene.addInstancedShard(fakeDevice(), instancedShardAt(-2), MODEL); // t = 2

    const hit = scene.raycast(RAY_ORIGIN, RAY_DIR);
    assert.equal(hit?.expressId, INSTANCED, 'the nearer instanced hit must win');
    // The other direction of the same comparison: the flat hit's ITEM must not
    // leak onto the occurrence that beat it.
    assert.equal(hit?.geometryItemId, undefined);
  });
});
