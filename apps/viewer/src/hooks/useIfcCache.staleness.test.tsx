/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadFromCache` must never write into the ACTIVE model slot once a newer load
 * owns it (PR #2301).
 *
 * The window is real and wide: the caller awaits `getCached` (IndexedDB), then
 * this function awaits the Blob materialization, `reader.read`, and — worst —
 * one `readChunk` PLUS an event-loop yield per geometry chunk. Anything the
 * function writes after those awaits (progress, the streaming flag, geometry
 * batches, instanced shards, the data store) lands in whatever model is active
 * *at that moment*, which for a superseded load is the file the user just
 * opened. The symptom is the new model blanking and then repopulating with the
 * previous file's geometry and properties.
 *
 * These tests drive the real function against a real multi-chunk v13 cache
 * buffer and flip the injected `isStale` predicate at each point where the
 * window opens, asserting that NOTHING moved afterwards. The two controls at
 * the bottom are what keep the fix honest: "guard everything" would satisfy
 * every staleness assertion here by breaking cache loads outright, so a
 * non-stale load must still write the full set, and a corrupt entry must still
 * report the plain miss that sends the caller to a fresh parse.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  RelationshipType,
} from '@ifc-lite/data';
import {
  BinaryCacheWriter,
  openGeometryChunksV13,
  SectionType,
  BinaryCacheReader,
  type CacheDataStore,
} from '@ifc-lite/cache';
import type { MeshData, CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { useIfcCache, type CacheResult, type CacheLoadResult } from './useIfcCache.js';

// ─── Fixture: a cache entry whose geometry spans SEVERAL chunks ──────────
//
// Chunking is spatial (a 32m grid cell per chunk, then a soft byte cap), so
// three tiny meshes 1000m apart give three chunks for a few hundred bytes —
// the cheap way to get the per-chunk `await` + yield the race needs. The
// `chunks.length >= 3` assertion below pins that: if chunking ever changed and
// collapsed these into one chunk, the between-chunks tests would silently stop
// testing anything.

function mesh(expressId: number, at: [number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.25, 0.125, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: at,
  };
}

const MESHES: MeshData[] = [
  mesh(4, [0, 0, 0]),
  mesh(5, [1000, 0, 0]),
  mesh(6, [2000, 0, 0]),
];

const COORD_INFO: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2001, y: 1, z: 0 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2001, y: 1, z: 0 } },
  hasLargeCoordinates: false,
};

const SOURCE_TEXT = [
  'ISO-10303-21;',
  'HEADER;',
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('guid-project');",
  "#3=IFCBUILDING('guid-building');",
  "#4=IFCWALL('guid-wall-1');",
  "#5=IFCWALL('guid-wall-2');",
  "#6=IFCWALL('guid-wall-3');",
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

function buildCacheDataStore(): CacheDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(10, strings);
  entityBuilder.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
  entityBuilder.add(3, 'IfcBuilding', 'guid-building', 'Test Building', '', '', false, false);
  entityBuilder.add(4, 'IfcWall', 'guid-wall-1', 'Wall 1', '', '', true, false);
  entityBuilder.add(5, 'IfcWall', 'guid-wall-2', 'Wall 2', '', '', true, false);
  entityBuilder.add(6, 'IfcWall', 'guid-wall-3', 'Wall 3', '', '', true, false);
  const relationshipBuilder = new RelationshipGraphBuilder();
  relationshipBuilder.addEdge(3, 4, RelationshipType.ContainsElements, 100);
  relationshipBuilder.addEdge(3, 5, RelationshipType.ContainsElements, 101);
  relationshipBuilder.addEdge(3, 6, RelationshipType.ContainsElements, 102);
  return {
    schema: 1,
    entityCount: 5,
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relationshipBuilder.build(),
  };
}

/** Opaque GPU-instancing payload — the loader only forwards the bytes. */
const SHARD_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

/**
 * Build the real v13 cache buffer the loader would have written.
 *
 * `withShards` defaults ON so the instanced-shard append (an active-slot write
 * that sat BELOW the old post-loop guard) is actually exercised. The truncation
 * fixtures turn it off: the shards section is written after the geometry one,
 * so with shards present a truncated tail would corrupt the shards instead of
 * a geometry chunk and never reach the chunk loop's error path.
 */
async function buildCacheEntry(
  options: { withGeometry?: boolean; withShards?: boolean } = {},
): Promise<CacheResult> {
  const { withGeometry = true, withShards = true } = options;
  const sourceBuffer = new TextEncoder().encode(SOURCE_TEXT).buffer as ArrayBuffer;
  const buffer = await new BinaryCacheWriter().write(
    buildCacheDataStore(),
    withGeometry
      ? {
          meshes: MESHES,
          totalVertices: 9,
          totalTriangles: 3,
          coordinateInfo: COORD_INFO,
          instancedShards: withShards ? [SHARD_BYTES] : undefined,
        }
      : undefined,
    sourceBuffer,
    { includeGeometry: withGeometry, omitSourceHash: true },
  );
  return { buffer, sourceBuffer };
}

function openGeometry(buffer: ArrayBuffer) {
  const header = new BinaryCacheReader().readHeader(buffer);
  const section = header.sections.find((s) => s.type === SectionType.Geometry);
  assert.ok(section, 'the fixture must carry a geometry section');
  return { open: openGeometryChunksV13(buffer, section.offset, header.version), section };
}

/** How many geometry chunks the fixture entry actually holds. */
function chunkCountOf(buffer: ArrayBuffer): number {
  return openGeometry(buffer).open.chunks.length;
}

/**
 * Cut the buffer through the MIDDLE of chunk 1 so chunk 0 decodes cleanly and
 * chunk 1 throws. Chopping a fixed number of bytes off the tail is not enough:
 * that only breaks the LAST chunk, which a superseded load never reaches (the
 * in-loop guard breaks out first), so the error path would never run.
 */
function truncateThroughSecondChunk(buffer: ArrayBuffer): ArrayBuffer {
  const { open, section } = openGeometry(buffer);
  assert.ok(open.chunks.length >= 2, 'need at least two chunks to truncate the second');
  const first = open.chunks[0];
  const second = open.chunks[1];
  assert.ok(
    second.byteOffset >= first.byteOffset + first.byteLength,
    'chunk 0 must be stored entirely before chunk 1',
  );
  return buffer.slice(0, section.offset + second.byteOffset + Math.ceil(second.byteLength / 2));
}

// ─── Harness: the real hook, rendered ────────────────────────────────────

type LoadFromCache = ReturnType<typeof useIfcCache>['loadFromCache'];

let root: Root | null = null;
let loadFromCache: LoadFromCache | null = null;

function Probe() {
  loadFromCache = useIfcCache().loadFromCache;
  return null;
}

/** Progress/streaming/geometry/shards/store — the whole active-slot surface. */
function snapshot() {
  const s = useViewerStore.getState();
  return {
    geometryMeshIds: (s.geometryResult?.meshes ?? []).map((m) => m.expressId),
    geometryResultIsNull: s.geometryResult === null,
    shards: s.pendingInstancedShards,
    ifcDataStore: s.ifcDataStore,
    progress: s.progress,
    streaming: s.geometryStreamingActive,
  };
}

/** The state a newer load has already painted into the active slot. */
const NEWER_LOADS_GEOMETRY: GeometryResult = {
  meshes: [mesh(999, [0, 0, 0])],
  totalVertices: 3,
  totalTriangles: 1,
  coordinateInfo: COORD_INFO,
};
const NEWER_LOADS_PROGRESS = { phase: 'Newer load in flight', percent: 42 };

/**
 * Seed the store as the NEWER load left it — geometry painted, its own progress
 * line up, its stream still open. Every staleness assertion below is then
 * "this is untouched", which is exactly the user-visible contract: the file the
 * user just opened must not flicker back to the previous one.
 */
function seedNewerLoadState() {
  useViewerStore.setState({
    geometryResult: NEWER_LOADS_GEOMETRY,
    pendingInstancedShards: null,
    ifcDataStore: null,
    progress: { ...NEWER_LOADS_PROGRESS },
    geometryStreamingActive: true,
  });
}

/**
 * The assertion for a load that started LIVE and was superseded mid-stream.
 *
 * Such a load legitimately owned the slot for its first two writes — the
 * "Loading from cache" progress line and the `setGeometryResult(null)` reset,
 * both of which happen before any await — so those two are not violations. What
 * must not happen afterwards is everything the streamed section writes: further
 * geometry, shards, the data store, the per-chunk / completion progress lines,
 * and lowering the newer load's streaming flag.
 */
function assertStreamAbandoned(result: CacheLoadResult, expectedMeshCount: number) {
  const after = snapshot();
  assert.equal(result.success, false, 'a superseded load must not report success');
  assert.equal(
    after.geometryMeshIds.length,
    expectedMeshCount,
    'no further geometry chunk may be appended after supersession',
  );
  assert.equal(after.shards, null, 'instanced shards must not be appended');
  assert.equal(after.ifcDataStore, null, 'the IFC data store must not be written');
  assert.equal(after.streaming, true, "the newer load's streaming flag must not be lowered");
  assert.equal(
    after.progress?.phase,
    'Loading from cache',
    'no progress past the pre-supersession line may be posted',
  );
}

function assertNothingMoved(before: ReturnType<typeof snapshot>, result: CacheLoadResult) {
  const after = snapshot();
  assert.equal(result.success, false, 'a superseded load must not report success');
  assert.deepEqual(after.geometryMeshIds, before.geometryMeshIds, 'geometry must not move');
  assert.equal(after.shards, before.shards, 'instanced shards must not move');
  assert.equal(after.ifcDataStore, before.ifcDataStore, 'the IFC data store must not move');
  assert.deepEqual(after.progress, before.progress, 'progress must not move');
  assert.equal(after.streaming, before.streaming, 'the streaming flag must not move');
}

beforeEach(async () => {
  loadFromCache = null;
  seedNewerLoadState();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(loadFromCache, 'the hook must expose loadFromCache');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.setState({
    geometryResult: null,
    pendingInstancedShards: null,
    ifcDataStore: null,
    geometryStreamingActive: false,
  });
});

async function load(entry: CacheResult, isStale: () => boolean): Promise<CacheLoadResult> {
  let result!: CacheLoadResult;
  await act(async () => {
    result = await loadFromCache!(entry, 'old.ifc', 'model-old', undefined, undefined, isStale);
  });
  return result;
}

describe('loadFromCache — a superseded load writes nothing (#2301)', () => {
  it('the fixture really does span several geometry chunks', async () => {
    const entry = await buildCacheEntry();
    assert.ok(
      chunkCountOf(entry.buffer as ArrayBuffer) >= 3,
      'the between-chunks tests are meaningless with a single chunk',
    );
  });

  it('supersession BEFORE the first cache state write leaves everything alone', async () => {
    // The caller awaited `getCached`; by the time this runs a newer load owns
    // the slot. Not even the "Loading from cache" progress line may land.
    const entry = await buildCacheEntry();
    const before = snapshot();
    const result = await load(entry, () => true);
    assertNothingMoved(before, result);
  });

  it('supersession while the entry is being read never opens a stream', async () => {
    // Flip the predicate on the very first progress write — i.e. after the
    // entry guard passed but before the awaited `reader.read` resolves. The
    // streaming flag is global active-model state, so a superseded load must
    // not raise it: `useGeometryStreaming` would then be waiting on a stream
    // that belongs to nobody.
    const entry = await buildCacheEntry();
    useViewerStore.setState({ geometryResult: null, geometryStreamingActive: false });
    let stale = false;
    const unsubscribe = useViewerStore.subscribe((s) => {
      if (s.progress?.phase === 'Loading from cache') stale = true;
    });
    try {
      const result = await load(entry, () => stale);
      assert.ok(stale, 'the supersession must actually have been triggered');
      const after = snapshot();
      assert.equal(result.success, false, 'a superseded load must not report success');
      assert.equal(after.streaming, false, 'a superseded load must not open a geometry stream');
      assert.equal(after.geometryMeshIds.length, 0, 'no geometry may be appended');
      assert.equal(after.shards, null, 'instanced shards must not be appended');
      assert.equal(after.ifcDataStore, null, 'the IFC data store must not be written');
    } finally {
      unsubscribe();
    }
  });

  it('supersession BETWEEN geometry chunks stops the stream mid-flight', async () => {
    // The window between raising the streaming flag and the first append holds
    // no store write at all (it is one `await readChunk`), so there is no state
    // change to hang the flip on — the predicate is driven by call ORDER
    // instead: call 1 is the entry guard, call 2 the pre-stream guard, call 3
    // the in-loop guard for chunk 0. Supersession therefore lands strictly
    // inside the loop, and ONLY the in-loop guard can catch it.
    //
    // The premise is asserted, not assumed: the streaming flag starts down and
    // must be UP afterwards, which proves the two earlier guards let this load
    // through and the loop really was entered.
    const entry = await buildCacheEntry();
    useViewerStore.setState({ geometryResult: null, geometryStreamingActive: false });
    let calls = 0;
    const result = await load(entry, () => ++calls >= 3);
    assert.ok(calls >= 3, 'the in-loop guard must have been reached');
    // Not one chunk may land: the flip happens while `readChunk(0)` is still in
    // flight, so the very first append is already superseded.
    assertStreamAbandoned(result, 0);
  });

  it('supersession AFTER a chunk landed appends no further chunk, shards or store', async () => {
    // The harsher interleaving: chunk 0 is already in the scene when the newer
    // load takes over. The old load cannot un-append it, but it must append
    // nothing MORE — no later chunk, no shards, no data store, no completion
    // progress — and it must not lower the newer load's streaming flag.
    const entry = await buildCacheEntry();
    // Start from an empty scene so "chunk 0 landed" is unambiguous.
    useViewerStore.setState({ geometryResult: null });
    let stale = false;
    const unsubscribe = useViewerStore.subscribe((s) => {
      if (s.geometryResult && s.geometryResult.meshes.length > 0) stale = true;
    });
    let result: CacheLoadResult;
    try {
      result = await load(entry, () => stale);
    } finally {
      unsubscribe();
    }
    assert.ok(stale, 'at least one chunk must have landed before supersession');
    // Each fixture mesh sits in its own spatial cell, so chunk 0 carries
    // exactly one — and chunks 1..n must never follow it.
    assertStreamAbandoned(result, 1);
  });

  it('a superseded load that then hits a corrupt chunk does not blank the new model', async () => {
    // The partial-geometry rollback in the chunk-loop `catch` is an active-slot
    // write too. On a superseded load the partial geometry in the store is the
    // NEWER model's, so rolling it back would blank the file the user is
    // looking at — and this load's own fallback reparse is abandoned anyway.
    const entry = await buildCacheEntry({ withShards: false });
    const truncated = truncateThroughSecondChunk(entry.buffer as ArrayBuffer);
    useViewerStore.setState({ geometryResult: null });
    let stale = false;
    const unsubscribe = useViewerStore.subscribe((s) => {
      if (s.geometryResult && s.geometryResult.meshes.length > 0) stale = true;
    });
    let result: CacheLoadResult;
    try {
      result = await load({ ...entry, buffer: truncated }, () => stale);
    } finally {
      unsubscribe();
    }
    assert.ok(stale, 'a chunk must have landed before the truncated one threw');
    assert.equal(result.success, false);
    // Whatever is in the slot at this point belongs to the load that owns it,
    // not to this one — it must still be there.
    assert.equal(
      snapshot().geometryResultIsNull,
      false,
      'a superseded load must not roll back geometry it no longer owns',
    );
  });

  it('supersession on a metadata-only entry does not write the store either', async () => {
    // The no-geometry branch is the `else` of the geometry branch, so it sees
    // NEITHER of the guards that branch carries — yet it still crosses the
    // awaited `reader.read` (and the Blob materialization), and it writes both
    // the data store and progress.
    //
    // Supersession has to land AFTER the entry guard or that guard catches it
    // and this branch is never reached, so the predicate goes by call order:
    // call 1 is the entry guard, call 2 is this branch's own guard. The
    // "Loading from cache" progress line below is the premise check — it only
    // exists if the entry guard let this load through.
    const entry = await buildCacheEntry({ withGeometry: false });
    useViewerStore.setState({ ifcDataStore: null });
    let calls = 0;
    const result = await load(entry, () => ++calls >= 2);
    assert.ok(calls >= 2, "the no-geometry branch's guard must have been reached");
    const after = snapshot();
    assert.equal(result.success, false, 'a superseded load must not report success');
    assert.equal(
      after.progress?.phase,
      'Loading from cache',
      'the entry guard must have let this load through (otherwise this proves nothing)',
    );
    assert.equal(after.ifcDataStore, null, 'the IFC data store must not be written');
  });
});

describe('loadFromCache — bounding controls: the fix must not disable caching', () => {
  it('a NON-stale load still serves the entry and writes everything', async () => {
    // Without this, "guard every write" would pass every test above by
    // refusing to load from cache at all.
    const entry = await buildCacheEntry();
    useViewerStore.setState({ geometryResult: null, geometryStreamingActive: false });
    const result = await load(entry, () => false);

    assert.equal(result.success, true, 'a live load must serve the cache hit');
    assert.equal(result.meshCount, MESHES.length);
    assert.equal(result.totalVertices, 9);
    assert.equal(result.totalTriangles, 3);

    const after = snapshot();
    assert.deepEqual(
      [...after.geometryMeshIds].sort((a, b) => a - b),
      MESHES.map((m) => m.expressId),
      'every chunk must have been appended',
    );
    assert.equal(after.shards?.length, 1, 'the instanced shards must be restored');
    assert.equal(after.shards?.[0].modelId, 'model-old', 'shards must be attributed to the model');
    assert.ok(after.ifcDataStore, 'the data store must be written');
    assert.equal(after.progress?.phase, 'Complete (from cache)', 'the load must report completion');
    assert.equal(after.streaming, false, 'the stream must be closed so the fragments finalize');
  });

  it('a non-stale load with no geometry section still hydrates the store', async () => {
    const entry = await buildCacheEntry({ withGeometry: false });
    useViewerStore.setState({ ifcDataStore: null });
    const result = await load(entry, () => false);
    assert.equal(result.success, true);
    assert.equal(result.meshCount, 0);
    assert.ok(useViewerStore.getState().ifcDataStore, 'the data store must be written');
  });

  it('a truncated entry still rolls partial geometry back for the load that OWNS the slot', async () => {
    // The other half of the rollback guard — and the proof that the truncated
    // fixture really does throw mid-stream (without that, the superseded-load
    // version of this test would pass vacuously).
    const entry = await buildCacheEntry({ withShards: false });
    const truncated = truncateThroughSecondChunk(entry.buffer as ArrayBuffer);
    useViewerStore.setState({ geometryResult: null });
    const result = await load({ ...entry, buffer: truncated }, () => false);
    assert.equal(result.success, false, 'a truncated entry must fail the load');
    assert.equal(
      snapshot().geometryResultIsNull,
      true,
      'the owning load must clear its own partial geometry for the fallback reparse',
    );
  });

  it('an ordinary MISS still reports failure so the caller reparses', async () => {
    // A corrupt entry with NO staleness: `success: false` is what sends the
    // caller through to the server/WASM path. An early return that swallowed
    // this would leave the model permanently unloaded.
    const corrupt = new Uint8Array(512);
    corrupt.set(new TextEncoder().encode('not-a-cache-file'));
    const result = await load({ buffer: corrupt.buffer }, () => false);
    assert.equal(result.success, false, 'a corrupt entry must report a plain miss');
    assert.equal(result.meshCount, 0);
  });
});
