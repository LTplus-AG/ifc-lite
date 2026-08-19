/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: a recipient's geometry is hydrated from blobs baked at
 * `meta.placementBaseline`, and NOTHING at hydrate time re-applied the live
 * `usd::xformop` on top. `packages/collab`'s `placement.ts` states the
 * invariant this file exists to make true:
 *
 *   "a late joiner that hydrates a blob baked at M₀ while `usd::xformop`
 *    already reads M₁ still places it correctly"
 *
 * It didn't. `hydrateGeometryFromRoom` reads `GeometryRef` / `blobHash` only,
 * and the only thing that ever moved a mesh was the live placement *event*.
 *
 * These tests drive the REAL doc (`createCollabDoc`, `setEntityPlacement`,
 * `setPlacementBaseline`), the REAL seed + hydrate (`seedGeometryToRoom`,
 * `hydrateGeometryFromRoom` over a `MemoryBlobStore`), and the REAL renderer
 * arithmetic (`rendererDeltaForPlacement` / `yawOf`, which `collabSlice`'s
 * reconciler imports from the same module) — so what they turn on is the
 * production path, not a re-statement of it.
 *
 * Each case asserts the pre-fix outcome first, so the bug cannot come back by
 * deleting the sweep: the "before" expectation is a permanent part of the test.
 *
 * Note on scope: the sweep hands each drifted entity to `collabSlice`'s
 * `reconcilePlacementMesh`, which resolves the moved mesh's `globalId` — that
 * resolution is #2706's subject and is pinned there
 * (`room-model-target.test.ts` + `scripts/check-collab-room-model-target.mjs`).
 * Here the reconciler stands in as a recorder built from the same exported
 * primitives, so the applied-map bookkeeping under test is the real one.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  MemoryBlobStore,
  addGeometryRef,
  createCollabDoc,
  createEntity,
  createGeometry,
  getGeometry,
  getGeometryRef,
  getEntityPlacement,
  getPlacementBaseline,
  hasEntity,
  iterEntities,
  setEntityPlacement,
  setGeometryRef,
  setPlacementBaseline,
} from '@ifc-lite/collab';
import type { CollabSession, LocalPlacement } from '@ifc-lite/collab';
import type { MeshData } from '@ifc-lite/geometry';
import {
  hydrateGeometryFromRoom,
  seedGeometryToRoom,
  type CollabGeomApi,
} from './geometry-sync.js';
import {
  clearAppliedPlacements,
  collectPlacementDrift,
  rendererDeltaForPlacement,
  sweepPlacements,
  yawOf,
  type PlacementSweepApi,
} from './placement-sweep.js';

/* ------------------------------------------------------------------ */
/* Harness — the real doc APIs, wired as `collabSlice` wires them.      */
/* ------------------------------------------------------------------ */

const geomApi: CollabGeomApi = {
  createGeometry: (doc, geomId, opts) => createGeometry(doc, geomId, opts),
  hasEntity: (doc, path) => hasEntity(doc, path),
  addGeometryRef: (doc, path, geomId) => addGeometryRef(doc, path, geomId),
  setGeometryRef: (doc, path, ref) => setGeometryRef(doc, path, ref),
  getGeometryRef: (doc, path) => getGeometryRef(doc, path),
  getGeometry: (doc, geomId) => getGeometry(doc, geomId),
  iterEntities: (doc) => iterEntities(doc),
};

const sweepApi: PlacementSweepApi = {
  iterEntities: (doc) => iterEntities(doc),
  getEntityPlacement: (doc, path) => getEntityPlacement(doc, path),
  getPlacementBaseline: (doc, path) => getPlacementBaseline(doc, path),
};

const WALL_PATH = '/OwnerWall';
const WALL_ID = 7;
const IDENTITY: LocalPlacement = { location: [0, 0, 0], axis: [0, 0, 1], refDirection: [1, 0, 0] };
/** IFC (Z-up) +10 along X. Renderer (Y-up) delta is (x, z, -y) = [10, 0, 0]. */
const MOVED: LocalPlacement = { location: [10, 0, 0], axis: [0, 0, 1], refDirection: [1, 0, 0] };

/** A unit triangle at the origin — the blob's baked position. */
function bakedMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWallStandardCase',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

function fakeSession(doc: ReturnType<typeof createCollabDoc>): CollabSession {
  return { doc, transact: (fn: () => void) => doc.transact(fn) } as unknown as CollabSession;
}

/**
 * Stands in for `collabSlice`'s `reconcilePlacementMesh`: pushes the
 * *incremental* renderer delta since this client last reconciled the entity,
 * and records the new absolute target in the applied maps. The arithmetic and
 * the maps are the production ones (same module, same functions) — only the
 * `globalId` resolution and the store write are elided.
 */
function makeReconciler(
  doc: ReturnType<typeof createCollabDoc>,
  appliedLoc: Map<number, [number, number, number]>,
  appliedYaw: Map<number, number>,
) {
  /** Renderer-frame position of each entity's mesh, starting at the blob's bake. */
  const rendered = new Map<number, [number, number, number]>();
  const reconcile = (entityId: number, placement: LocalPlacement): void => {
    const baseline = getPlacementBaseline(doc, WALL_PATH) ?? IDENTITY;
    const target = rendererDeltaForPlacement(baseline, placement);
    const applied = appliedLoc.get(entityId) ?? [0, 0, 0];
    const inc: [number, number, number] = [
      target[0] - applied[0],
      target[1] - applied[1],
      target[2] - applied[2],
    ];
    const at = rendered.get(entityId) ?? [0, 0, 0];
    rendered.set(entityId, [at[0] + inc[0], at[1] + inc[1], at[2] + inc[2]]);
    appliedLoc.set(entityId, target);
    appliedYaw.set(entityId, yawOf(placement) - yawOf(baseline));
  };
  return {
    reconcile,
    /** Where the entity's mesh currently renders, relative to its baked bake. */
    positionOf: (entityId: number): [number, number, number] => rendered.get(entityId) ?? [0, 0, 0],
    /** Re-hydration rebuilds meshes from blobs — back at the bake, by definition. */
    rehydrated: (entityId: number) => rendered.set(entityId, [0, 0, 0]),
  };
}

describe('reconstruct-side placement sweep', () => {
  let doc: ReturnType<typeof createCollabDoc>;
  let session: CollabSession;
  let blobStore: MemoryBlobStore;
  let pathToId: Map<string, number>;
  let appliedLoc: Map<number, [number, number, number]>;
  let appliedYaw: Map<number, number>;

  /** Owner's room: one entity, its mesh seeded as a blob, baseline stamped. */
  async function seedRoom(): Promise<void> {
    createEntity(doc, WALL_PATH, { ifcClass: 'IfcWall' });
    setEntityPlacement(doc, WALL_PATH, IDENTITY);
    setPlacementBaseline(doc, WALL_PATH, IDENTITY);
    const report = await seedGeometryToRoom(
      geomApi,
      session,
      blobStore,
      [bakedMesh(WALL_ID)],
      (id) => (id === WALL_ID ? WALL_PATH : null),
    );
    assert.equal(report.seeded, 1, 'the fixture must actually seed a blob');
  }

  beforeEach(() => {
    doc = createCollabDoc();
    session = fakeSession(doc);
    blobStore = new MemoryBlobStore();
    pathToId = new Map([[WALL_PATH, WALL_ID]]);
    appliedLoc = new Map();
    appliedYaw = new Map();
  });

  it('the premise: hydration never reads `usd::xformop`, so a moved entity arrives at its bake', async () => {
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);
    assert.deepEqual(getEntityPlacement(doc, WALL_PATH)?.location, [10, 0, 0]);
    assert.deepEqual(getPlacementBaseline(doc, WALL_PATH)?.location, [0, 0, 0]);

    const meshes = await hydrateGeometryFromRoom(geomApi, session, blobStore, pathToId);
    assert.equal(meshes.length, 1);
    // Identical to what was baked: the doc says +10 X, the mesh says 0.
    assert.deepEqual(Array.from(meshes[0].positions), Array.from(bakedMesh(WALL_ID).positions));
  });

  /* ---- Case 1: a placement event dropped before the model existed ---- */

  it('case 1 — recovers a placement event dropped before the room model was registered', async () => {
    await seedRoom();
    // The peer's move lands in the doc while this client has no model to move,
    // so no `onPlacement` reaches a mesh: the applied maps stay empty.
    setEntityPlacement(doc, WALL_PATH, MOVED);
    assert.equal(appliedLoc.size, 0, 'pre-fix: nothing was ever applied');

    const r = makeReconciler(doc, appliedLoc, appliedYaw);
    // Pre-fix, reconstruct ended here — the mesh stays where the blob baked it.
    assert.deepEqual(r.positionOf(WALL_ID), [0, 0, 0]);

    const swept = sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile);
    assert.equal(swept, 1);
    assert.deepEqual(r.positionOf(WALL_ID), [10, 0, 0]);
  });

  /* ---- Case 2: a plain late joiner, no dropped event at all ---- */

  it('case 2 — places a late joiner correctly, the case the baseline docstring claims', async () => {
    // Owner moves the entity, then this client joins: it hydrates the blob and
    // receives no placement event, because the change predates its session.
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);

    const meshes = await hydrateGeometryFromRoom(geomApi, session, blobStore, pathToId);
    assert.equal(meshes.length, 1, 'the late joiner does get the mesh…');
    const r = makeReconciler(doc, appliedLoc, appliedYaw);
    assert.deepEqual(r.positionOf(WALL_ID), [0, 0, 0], '…but at M₀, not M₁');

    sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile);
    assert.deepEqual(r.positionOf(WALL_ID), [10, 0, 0]);
  });

  /* ---- Case 3: a peer create/delete reverts every applied move ---- */

  it('case 3 — a re-hydrate reverts an applied move, and a stale applied map pins it there', async () => {
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);
    const r = makeReconciler(doc, appliedLoc, appliedYaw);

    // This client saw the move live and applied it.
    sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile);
    assert.deepEqual(r.positionOf(WALL_ID), [10, 0, 0]);
    assert.deepEqual(appliedLoc.get(WALL_ID), [10, 0, 0]);

    // A peer creates or deletes an element: `geomCount` changes, every mesh is
    // rebuilt from its baked blob, and the move is gone from the screen.
    r.rehydrated(WALL_ID);
    assert.deepEqual(r.positionOf(WALL_ID), [0, 0, 0], 'the move snapped back to the bake');

    // Pre-fix, the applied map still claimed [10,0,0] — so the sweep saw no
    // drift and the revert became permanent AND silent.
    assert.equal(
      collectPlacementDrift(sweepApi, doc, pathToId, appliedLoc, appliedYaw).length,
      0,
      'pre-fix: a stale applied map suppresses the re-application',
    );
    sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile);
    assert.deepEqual(r.positionOf(WALL_ID), [0, 0, 0], 'pre-fix: still reverted');

    // The fix: fresh meshes are back at the bake, so the bookkeeping that
    // described the old ones has to go with them.
    clearAppliedPlacements(appliedLoc, appliedYaw);
    assert.equal(sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile), 1);
    assert.deepEqual(r.positionOf(WALL_ID), [10, 0, 0]);
  });

  /* ---- Idempotence + fail-closed behaviour ---- */

  it('is idempotent: a second sweep over an unchanged doc reconciles nothing', async () => {
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);
    const r = makeReconciler(doc, appliedLoc, appliedYaw);
    assert.equal(sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile), 1);
    assert.equal(sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile), 0);
    assert.equal(sweepPlacements(sweepApi, doc, pathToId, appliedLoc, appliedYaw, r.reconcile), 0);
    assert.deepEqual(r.positionOf(WALL_ID), [10, 0, 0], 'applied exactly once');
  });

  it('sweeps a rotation as well as a translation', async () => {
    await seedRoom();
    // Yaw 90° about Z, same location.
    setEntityPlacement(doc, WALL_PATH, {
      location: [0, 0, 0],
      axis: [0, 0, 1],
      refDirection: [0, 1, 0],
    });
    const drift = collectPlacementDrift(sweepApi, doc, pathToId, appliedLoc, appliedYaw);
    assert.equal(drift.length, 1, 'a pure rotation is drift too');
    assert.ok(Math.abs(yawOf(drift[0].placement) - Math.PI / 2) < 1e-9);
  });

  it('does not sweep an entity that never moved', async () => {
    await seedRoom();
    assert.equal(collectPlacementDrift(sweepApi, doc, pathToId, appliedLoc, appliedYaw).length, 0);
  });

  it('does not stamp a baseline it did not find — an unstamped entity is left to the live reconciler', async () => {
    createEntity(doc, WALL_PATH, { ifcClass: 'IfcWall' });
    setEntityPlacement(doc, WALL_PATH, MOVED);
    assert.equal(getPlacementBaseline(doc, WALL_PATH), null);

    assert.equal(collectPlacementDrift(sweepApi, doc, pathToId, appliedLoc, appliedYaw).length, 0);
    // Still unstamped: a sweep is a read, so late joiners can't race to freeze
    // the baseline (`setPlacementBaseline` is first-writer-wins).
    assert.equal(getPlacementBaseline(doc, WALL_PATH), null);
  });

  it('ignores entities this client has no expressId for', async () => {
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);
    assert.equal(collectPlacementDrift(sweepApi, doc, new Map(), appliedLoc, appliedYaw).length, 0);
    assert.equal(collectPlacementDrift(sweepApi, doc, undefined, appliedLoc, appliedYaw).length, 0);
  });

  it('clears applied bookkeeping for named entities only, when given a set', () => {
    appliedLoc.set(1, [1, 0, 0]);
    appliedLoc.set(2, [2, 0, 0]);
    appliedYaw.set(1, 0.5);
    appliedYaw.set(2, 0.5);
    clearAppliedPlacements(appliedLoc, appliedYaw, [1]);
    assert.equal(appliedLoc.has(1), false);
    assert.equal(appliedYaw.has(1), false);
    assert.deepEqual(appliedLoc.get(2), [2, 0, 0]);
    assert.equal(appliedYaw.get(2), 0.5);
  });

  it('tolerates a torn-down session (null applied maps)', async () => {
    await seedRoom();
    setEntityPlacement(doc, WALL_PATH, MOVED);
    assert.equal(collectPlacementDrift(sweepApi, doc, pathToId, null, null).length, 1);
    clearAppliedPlacements(null, null);
  });
});
