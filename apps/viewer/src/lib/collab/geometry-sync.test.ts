/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createCollabDoc,
  createGeometry,
  hasEntity,
  addGeometryRef,
  setGeometryRef,
  getGeometryRef,
  getGeometry,
  iterEntities,
  seedFromStep,
  guidToPath,
  MemoryBlobStore,
} from '@ifc-lite/collab';
import type { BlobMeta, BlobStore } from '@ifc-lite/collab';
import type { MeshData } from '@ifc-lite/geometry';
import { encodeMesh, decodeMesh } from './mesh-codec.js';
import { MAX_RETRY_DELAY_MS, boundedRetryDelayMs } from './blob-upload.js';
import {
  seedGeometryToRoom,
  hydrateGeometryFromRoom,
  buildGeometryResultFromMeshes,
  type CollabGeomApi,
} from './geometry-sync.js';

function sampleMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWallStandardCase',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    // f32-exact values so the round-trip compares cleanly.
    color: [0.5, 0.25, 0.75, 1],
  };
}

const api: CollabGeomApi = {
  createGeometry: (doc, geomId, opts) => createGeometry(doc, geomId, opts),
  hasEntity: (doc, path) => hasEntity(doc, path),
  addGeometryRef: (doc, path, geomId) => addGeometryRef(doc, path, geomId),
  setGeometryRef: (doc, path, ref) => setGeometryRef(doc, path, ref),
  getGeometryRef: (doc, path) => getGeometryRef(doc, path),
  getGeometry: (doc, geomId) => getGeometry(doc, geomId),
  iterEntities: (doc) => iterEntities(doc),
};

describe('mesh-codec', () => {
  it('round-trips a mesh exactly', () => {
    const mesh = sampleMesh(42);
    const decoded = decodeMesh(encodeMesh(mesh));
    assert.equal(decoded.expressId, 42);
    assert.equal(decoded.ifcType, 'IfcWallStandardCase');
    assert.deepEqual(Array.from(decoded.positions), Array.from(mesh.positions));
    assert.deepEqual(Array.from(decoded.normals), Array.from(mesh.normals));
    assert.deepEqual(Array.from(decoded.indices), Array.from(mesh.indices));
    assert.deepEqual(decoded.color, mesh.color);
  });

  it('rejects a buffer with a bad magic', () => {
    assert.throws(() => decodeMesh(new Uint8Array(32)));
  });
});

describe('geometry-sync seed → hydrate', () => {
  it('reconstructs meshes from the room blobs', async () => {
    const doc = createCollabDoc();
    const guidA = '0aBcDeFgHiJkLmNoPqRsT1';
    const guidB = '0aBcDeFgHiJkLmNoPqRsT2';
    seedFromStep(doc, {
      entities: [
        { guid: guidA, ifcClass: 'IfcWallStandardCase' },
        { guid: guidB, ifcClass: 'IfcSlab' },
      ],
    });

    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;

    const expressToGuid = new Map<number, string>([
      [1, guidToPath(guidA)],
      [2, guidToPath(guidB)],
    ]);
    const meshes = [sampleMesh(1), sampleMesh(2)];

    const seeded = await seedGeometryToRoom(
      api,
      session,
      blobStore,
      meshes,
      (id) => expressToGuid.get(id) ?? null,
    );
    assert.equal(seeded.seeded, 2);

    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore);
    assert.equal(hydrated.length, 2);
    const ids = hydrated.map((m) => m.expressId).sort();
    assert.deepEqual(ids, [1, 2]);
    for (const m of hydrated) {
      assert.deepEqual(Array.from(m.positions), Array.from(sampleMesh(m.expressId).positions));
    }
  });

  it('hydrates every mesh when one entity owns several (multi-material)', async () => {
    // A single element tessellated into 3 distinct meshes that all map to the
    // same GUID path. The per-entity GeometryRef can only hold one geomId, so
    // hydrating must read the geometry store, not the (last-wins) entity ref.
    const doc = createCollabDoc();
    const guid = '0aBcDeFgHiJkLmNoPqRsT9';
    seedFromStep(doc, { entities: [{ guid, ifcClass: 'IfcWallStandardCase' }] });

    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;

    // Three meshes, same expressId → same path. Vary geometry so the blobs are
    // distinct (content-addressed dedupe would otherwise collapse them).
    const meshes: MeshData[] = [0, 1, 2].map((k) => ({
      ...sampleMesh(7),
      positions: new Float32Array([0, 0, k, 1, 0, k, 0, 1, k]),
    }));

    const seeded = await seedGeometryToRoom(api, session, blobStore, meshes, () => guidToPath(guid));
    assert.equal(seeded.seeded, 3);

    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore);
    assert.equal(hydrated.length, 3, 'all 3 meshes recovered despite the shared entity path');
    const zs = hydrated.map((m) => m.positions[2]).sort();
    assert.deepEqual(zs, [0, 1, 2]);
  });

  it('re-keys mesh expressIds via pathToId (recipient id space)', async () => {
    const doc = createCollabDoc();
    const guidA = '0aBcDeFgHiJkLmNoPqRsT1';
    const guidB = '0aBcDeFgHiJkLmNoPqRsT2';
    seedFromStep(doc, {
      entities: [
        { guid: guidA, ifcClass: 'IfcWallStandardCase' },
        { guid: guidB, ifcClass: 'IfcSlab' },
      ],
    });
    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;
    const expressToGuid = new Map<number, string>([
      [1, guidToPath(guidA)],
      [2, guidToPath(guidB)],
    ]);
    await seedGeometryToRoom(api, session, blobStore, [sampleMesh(1), sampleMesh(2)], (id) =>
      expressToGuid.get(id) ?? null,
    );

    // Recipient reconstructs ids by path: guidA→100, guidB→200.
    const pathToId = new Map<string, number>([
      [guidToPath(guidA), 100],
      [guidToPath(guidB), 200],
    ]);
    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore, pathToId);
    assert.deepEqual(
      hydrated.map((m) => m.expressId).sort((a, b) => a - b),
      [100, 200],
      'expressIds are re-keyed into the recipient id space',
    );
  });
});

/**
 * A blob store that fails on demand, so a seed can be driven through the two
 * failure shapes production produced: one blob rejecting (a corrupt/oversized
 * upload) and every blob rejecting (the server volume out of inodes).
 */
class FlakyBlobStore implements BlobStore {
  readonly inner = new MemoryBlobStore();
  /** put() calls made, including the ones that threw. */
  attempts = 0;
  constructor(private readonly failOn: (attempt: number) => boolean) {}
  async put(bytes: Uint8Array, contentType?: string): Promise<BlobMeta> {
    this.attempts++;
    if (this.failOn(this.attempts)) throw new Error('HTTP 500: ENOSPC');
    return this.inner.put(bytes, contentType);
  }
  get(hash: string) {
    return this.inner.get(hash);
  }
  has(hash: string) {
    return this.inner.has(hash);
  }
  delete(hash: string) {
    return this.inner.delete(hash);
  }
  list() {
    return this.inner.list();
  }
}

/** `count` entities in a doc, plus the expressId -> path map for them. */
function docWithEntities(count: number): {
  doc: ReturnType<typeof createCollabDoc>;
  session: never;
  pathFor: (id: number) => string | null;
} {
  const doc = createCollabDoc();
  const guidFor = (i: number) => `0aBcDeFgHiJkLmNoP${String(i).padStart(4, 'q')}`;
  seedFromStep(doc, {
    entities: Array.from({ length: count }, (_, i) => ({ guid: guidFor(i), ifcClass: 'IfcWall' })),
  });
  return {
    doc,
    session: { doc, transact: (fn: () => void) => doc.transact(fn) } as never,
    pathFor: (id) => (id >= 0 && id < count ? guidToPath(guidFor(id)) : null),
  };
}

/** Distinct meshes, so content-addressing cannot dedupe them into one blob. */
function distinctMeshes(count: number): MeshData[] {
  return Array.from({ length: count }, (_, i) => ({
    ...sampleMesh(i),
    positions: new Float32Array([0, 0, i, 1, 0, i, 0, 1, i]),
  }));
}

describe('hydrate does not hand out aliased vertex data', () => {
  // Found via Louis's NEEDS-CHANGES on #2708, which observed that hydrate
  // shallow-cloned cached meshes "under a comment asserting (read-only)".
  // Verified against the renderer: `translateFlatMeshesForEntity` and
  // `rotateMeshesForEntity` (`packages/renderer/src/scene.ts`) write
  // `pos[i] = ...` IN PLACE, and `scene` stores the caller's mesh object, so
  // the array it mutates is the one hydrate handed it.
  //
  // The renderer's own guard against moving a shared mesh keys on
  // `meshData.entityIds`, which a hydrated mesh does not carry - so it never
  // applied to this path.

  it('gives two entities sharing ONE blob their own positions and normals', async () => {
    // Two entities referencing the SAME geomId is the case that matters, and
    // it cannot be built through `seedGeometryToRoom`: mesh-codec encodes the
    // expressId, so two meshes only hash alike if they ARE the same mesh, and
    // then `pathFor` sends them to one path. (My first version of this test
    // seeded two meshes and asserted they were unaliased - they were, because
    // they had different hashes and never shared a cache entry at all. The
    // fixture did not build the situation its name described.)
    //
    // So the ref is attached to both entities directly, which is exactly what
    // the doc holds when a model has repeated geometry.
    const doc = createCollabDoc();
    const guidA = '0aBcDeFgHiJkLmNoPqRsT1';
    const guidB = '0aBcDeFgHiJkLmNoPqRsT2';
    seedFromStep(doc, {
      entities: [
        { guid: guidA, ifcClass: 'IfcWallStandardCase' },
        { guid: guidB, ifcClass: 'IfcWallStandardCase' },
      ],
    });
    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;
    await seedGeometryToRoom(api, session, blobStore, [sampleMesh(1)], () => guidToPath(guidA));
    // The second entity references the SAME geomId.
    const geomId = getGeometryRef(doc, guidToPath(guidA))!.geomIds[0];
    addGeometryRef(doc, guidToPath(guidB), geomId);

    // `concurrency: 1` is load-bearing, not tidiness. With the default, both
    // workers check the empty cache before either fills it, so both DECODE and
    // the two meshes come back distinct by a race rather than by the fix -
    // which made this test pass against the aliasing defect it exists to
    // catch. Serialised, the second job takes the cache HIT, which is the
    // path where sharing actually happened.
    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore, undefined, {
      cache: new Map(),
      concurrency: 1,
    });
    assert.equal(hydrated.length, 2, 'both entities hydrate from the one blob');
    assert.notStrictEqual(
      hydrated[0].positions,
      hydrated[1].positions,
      'two entities must not share one positions array',
    );
    assert.notStrictEqual(hydrated[0].normals, hydrated[1].normals, 'nor one normals array');

    // What the renderer actually does to a moved element, on both arrays it
    // writes to in place.
    hydrated[0].positions[0] += 5;
    hydrated[0].normals![0] = 0.5;
    assert.equal(hydrated[1].positions[0], sampleMesh(1).positions[0], 'the twin did not move');
    assert.equal(hydrated[1].normals![0], sampleMesh(1).normals[0], 'nor did its normals rotate');
  });

  it('keeps the cache pristine when a hydrated mesh is mutated', async () => {
    // Any peer edit re-runs the reconstruct, which re-hydrates from this cache.
    // If a move mutated the cached array, the re-hydrate returned geometry
    // already displaced instead of the baked original.
    const doc = createCollabDoc();
    const guid = '0aBcDeFgHiJkLmNoPqRsT7';
    seedFromStep(doc, { entities: [{ guid, ifcClass: 'IfcWallStandardCase' }] });
    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;
    await seedGeometryToRoom(api, session, blobStore, [sampleMesh(1)], () => guidToPath(guid));

    const cache = new Map<string, MeshData>();
    const first = await hydrateGeometryFromRoom(api, session, blobStore, undefined, { cache });
    first[0].positions[0] += 5;
    first[0].normals![0] = 0.5;

    const second = await hydrateGeometryFromRoom(api, session, blobStore, undefined, { cache });
    assert.equal(
      second[0].positions[0],
      sampleMesh(1).positions[0],
      're-hydrate must return the baked geometry, not a previously moved copy',
    );
    assert.equal(second[0].normals![0], sampleMesh(1).normals[0], 'normals too: the renderer rotates them in place');
  });

  it('still shares the INDEX array, which nothing mutates', async () => {
    // The bounding control: copying indices too would double the cost of the
    // larger array for no benefit, so the fix is deliberately narrow.
    const doc = createCollabDoc();
    const guid = '0aBcDeFgHiJkLmNoPqRsT8';
    seedFromStep(doc, { entities: [{ guid, ifcClass: 'IfcWallStandardCase' }] });
    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;
    await seedGeometryToRoom(api, session, blobStore, [sampleMesh(1)], () => guidToPath(guid));

    const cache = new Map<string, MeshData>();
    const a = await hydrateGeometryFromRoom(api, session, blobStore, undefined, { cache });
    const b = await hydrateGeometryFromRoom(api, session, blobStore, undefined, { cache });
    assert.strictEqual(a[0].indices, b[0].indices, 'indices are shared on purpose');
  });
});

describe('geometry-sync seed resilience', () => {
  it('keeps the meshes that uploaded when one blob fails', async () => {
    // The failure used to reject the enclosing Promise.all, so step 3 never
    // ran and the room ended up with NO geometry at all rather than "all but
    // the one that failed".
    const { session, pathFor } = docWithEntities(3);
    const blobStore = new FlakyBlobStore((attempt) => attempt === 2);

    const seeded = await seedGeometryToRoom(api, session, blobStore, distinctMeshes(3), pathFor, {
      concurrency: 1,
      // Retries off: this is about isolating a blob that stays broken, not
      // about recovering a transient one (the next test covers that).
      retries: 0,
    });

    assert.equal(seeded.seeded, 2, 'the two blobs that uploaded are in the room');
    assert.equal(seeded.failed, 1);
    assert.equal(seeded.offered, 3);
    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore);
    assert.equal(hydrated.length, 2, 'a joiner gets the meshes that survived');
  });

  it('retries a transient upload failure instead of losing the mesh', async () => {
    const { session, pathFor } = docWithEntities(1);
    const blobStore = new FlakyBlobStore((attempt) => attempt === 1);

    const seeded = await seedGeometryToRoom(api, session, blobStore, distinctMeshes(1), pathFor, {
      concurrency: 1,
      retryDelaysMs: [0, 0],
    });

    assert.equal(seeded.seeded, 1, 'the second attempt landed the mesh');
    assert.equal(seeded.failed, 0);
    assert.equal(blobStore.attempts, 2);
  });

  it('stops uploading once the store is refusing everything', async () => {
    // Inode exhaustion failed every PUT. Retrying all of them would issue
    // meshes x (1 + retries) doomed requests, and the user waits through all
    // of it before being told anything.
    const { session, pathFor } = docWithEntities(40);
    const blobStore = new FlakyBlobStore(() => true);

    const seeded = await seedGeometryToRoom(api, session, blobStore, distinctMeshes(40), pathFor, {
      concurrency: 1,
      retries: 1,
      retryDelaysMs: [0],
      maxFailures: 5,
    });

    assert.equal(seeded.abandoned, true, 'a systemic upload failure is reported as such');
    assert.equal(seeded.seeded, 0);
    assert.equal(seeded.failed, 5);
    assert.equal(blobStore.attempts, 10, '5 failures x 2 attempts, not 40 meshes x 2');
  });

  it('keeps the failure ceiling when it is configured with a NaN', async () => {
    // `failures >= NaN` is false forever: a NaN override would silently remove
    // the ceiling rather than widen it, which is the worst of both.
    const { session, pathFor } = docWithEntities(40);
    const blobStore = new FlakyBlobStore(() => true);

    const seeded = await seedGeometryToRoom(api, session, blobStore, distinctMeshes(40), pathFor, {
      concurrency: 1,
      retries: 1,
      retryDelaysMs: [0],
      maxFailures: Number.NaN,
    });

    assert.equal(seeded.abandoned, true);
    assert.ok(blobStore.attempts < 80, `bounded by the default ceiling, got ${blobStore.attempts} attempts`);
  });

  it('still uploads when concurrency is configured with a NaN', async () => {
    // `Math.min(NaN, n)` is NaN and `Array.from({length: NaN})` builds ZERO
    // workers, so a NaN here uploads nothing while every other signal looks
    // like a normal seed that simply found nothing.
    const { session, pathFor } = docWithEntities(3);
    const blobStore = new MemoryBlobStore();

    const seeded = await seedGeometryToRoom(api, session, blobStore, distinctMeshes(3), pathFor, {
      concurrency: Number.NaN,
    });

    assert.equal(seeded.seeded, 3);
  });

  it('counts meshes whose CPU data was released, so the caller sees an empty seed', async () => {
    // Bounded-geometry mode on a large model: every mesh is present but has no
    // triangles. Nothing throws, nothing uploads, the room gets nothing, and
    // the owner's own viewport still renders from its GPU copy.
    const { session, pathFor } = docWithEntities(2);
    const blobStore = new MemoryBlobStore();
    const released = distinctMeshes(2).map((m) => ({
      ...m,
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
    }));

    const seeded = await seedGeometryToRoom(api, session, blobStore, released, pathFor, {
      concurrency: 1,
    });

    assert.equal(seeded.offered, 2);
    assert.equal(seeded.attempted, 0);
    assert.equal(seeded.seeded, 0);
    assert.equal(seeded.skipped.empty, 2);
  });
});

describe('retry backoff bounds', () => {
  it('clamps a backoff that setTimeout would turn into an instant retry', () => {
    // Measured: `setTimeout(fn, 2 ** 31)` fires in 1ms. An over-large backoff
    // is the same flood as a zero one, from the other end.
    assert.equal(boundedRetryDelayMs(2 ** 31), MAX_RETRY_DELAY_MS);
    assert.equal(boundedRetryDelayMs(Number.MAX_SAFE_INTEGER), MAX_RETRY_DELAY_MS);
  });

  it('treats a NaN, infinite or negative backoff as no wait', () => {
    assert.equal(boundedRetryDelayMs(Number.NaN), 0);
    assert.equal(boundedRetryDelayMs(Number.POSITIVE_INFINITY), 0);
    assert.equal(boundedRetryDelayMs(-5), 0);
    assert.equal(boundedRetryDelayMs(undefined), 0);
  });

  it('passes a sane backoff through untouched', () => {
    assert.equal(boundedRetryDelayMs(150), 150);
  });
});

describe('buildGeometryResultFromMeshes', () => {
  it('computes totals + bounds for the renderer', () => {
    const result = buildGeometryResultFromMeshes([sampleMesh(1), sampleMesh(2)]);
    assert.equal(result.meshes.length, 2);
    assert.equal(result.totalTriangles, 2); // one triangle each
    assert.equal(result.totalVertices, 6); // three verts each
    assert.deepEqual(result.coordinateInfo.originShift, { x: 0, y: 0, z: 0 });
    assert.equal(result.coordinateInfo.shiftedBounds.max.x, 1);
    assert.equal(result.coordinateInfo.shiftedBounds.max.y, 1);
  });

  it('returns zero bounds for an empty mesh list', () => {
    const result = buildGeometryResultFromMeshes([]);
    assert.equal(result.totalVertices, 0);
    assert.deepEqual(result.coordinateInfo.shiftedBounds.min, { x: 0, y: 0, z: 0 });
  });
});
