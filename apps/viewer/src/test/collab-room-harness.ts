/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Owner → room → recipient harness for the multi-model room tests (#4444).
 *
 * The owner side (`runOwnerSeed`) and the recipient side
 * (`createRoomReconstructor`) are driven for real, against a real collab
 * document, a real `MemoryBlobStore`, the real IFCX importer
 * (`parseIfcxViewerModel`) and the real model/data slices, so a test's
 * assertions are about what a joiner's store ends up holding — not about
 * which functions were called. Shared by the synthetic two-copy test
 * (`room-reconstruct.test.ts`) and the real-fixture one
 * (`room-two-copies.ac20.test.ts`).
 */

import assert from 'node:assert/strict';
import * as collab from '@ifc-lite/collab';
import type { CollabSession, ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createModelSlice, type ModelSlice } from '../store/slices/modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from '../store/slices/dataSlice.js';
import type { ViewerState } from '../store/index.js';
import { parseIfcxViewerModel } from '../hooks/ingest/viewerModelIngest.js';
import {
  createRoomReconstructor,
  type RoomReconstructDeps,
  type RoomReconstructState,
} from '../lib/collab/room-reconstruct.js';
import { runOwnerSeed, type CollabSeedModel } from '../lib/collab/owner-seed.js';
import type { CollabGeomApi } from '../lib/collab/geometry-sync.js';
import type { PlacementSweepApi } from '../lib/collab/placement-sweep.js';

export type RoomDoc = ReturnType<typeof collab.createCollabDoc>;

export const geomApi: CollabGeomApi = {
  createGeometry: (doc, geomId, opts) => collab.createGeometry(doc, geomId, opts),
  hasEntity: (doc, path) => collab.hasEntity(doc, path),
  addGeometryRef: (doc, path, geomId) => collab.addGeometryRef(doc, path, geomId),
  setGeometryRef: (doc, path, ref) => collab.setGeometryRef(doc, path, ref),
  getGeometryRef: (doc, path) => collab.getGeometryRef(doc, path),
  getGeometry: (doc, geomId) => collab.getGeometry(doc, geomId),
  iterEntities: (doc) => collab.iterEntities(doc),
};
export const sweepApi: PlacementSweepApi = {
  iterEntities: (doc) => collab.iterEntities(doc),
  getEntityPlacement: (doc, path) => collab.getEntityPlacement(doc, path),
  getPlacementBaseline: (doc, path) => collab.getPlacementBaseline(doc, path),
};

export function fakeSession(doc: RoomDoc): CollabSession {
  return {
    doc,
    whenSynced: Promise.resolve(),
    transact: (fn: () => void) => doc.transact(fn),
  } as unknown as CollabSession;
}

/** The owner's real seed, one slot per model, phases recorded. */
export async function ownerShare(
  doc: RoomDoc,
  blobStore: collab.MemoryBlobStore,
  models: CollabSeedModel[],
  roomModels: ReadonlyMap<string, ModelSlotRef>,
) {
  const session = fakeSession(doc);
  const phases: string[] = [];
  const outcome = await runOwnerSeed({
    session,
    seed: { models },
    collab,
    geomApi,
    makeBlobStore: async () => blobStore,
    parseIfcx: () => Promise.reject(new Error('STEP seeds never re-parse')),
    roomModels,
    stampBaseline: (path) => {
      if (path) {
        const current = collab.getEntityPlacement(doc, path);
        collab.setPlacementBaseline(doc, path, current ?? { location: [0, 0, 0] });
      }
      return path;
    },
    isCurrent: () => true,
    onPhase: (phase) => phases.push(phase),
    onProgress: () => {},
  });
  return { outcome, phases };
}

export type RoomTestState = ModelSlice &
  DataSlice &
  DataCrossSliceState & {
    collabRoomId: string | null;
    collabRoomModels: ReadonlyMap<string, ModelSlotRef>;
    mutationViews: Map<string, MutablePropertyView>;
  };

/** A recipient's store: the real model + data slices, nothing loaded. */
export function recipientState(roomId: string): { get: () => RoomTestState; state: () => RoomTestState } {
  let state: RoomTestState;
  const setState = (partial: unknown) => {
    const updates =
      typeof partial === 'function'
        ? (partial as (s: RoomTestState) => Partial<RoomTestState>)(state)
        : (partial as Partial<RoomTestState>);
    state = { ...state, ...updates };
  };
  const getState = () => state as unknown as ViewerState;
  const modelSlice = createModelSlice(
    setState as Parameters<typeof createModelSlice>[0],
    getState as Parameters<typeof createModelSlice>[1],
    undefined as unknown as Parameters<typeof createModelSlice>[2],
  );
  const dataSlice = createDataSlice(
    setState as Parameters<typeof createDataSlice>[0],
    getState as Parameters<typeof createDataSlice>[1],
    undefined as unknown as Parameters<typeof createDataSlice>[2],
  );
  state = {
    ...modelSlice,
    ...dataSlice,
    collabRoomId: roomId,
    collabRoomModels: new Map(),
    mutationViews: new Map(),
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedStoreys: new Set(),
    hiddenEntities: new Set(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    classFilter: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
    pinboardEntities: new Set(),
    hierarchyBasketSelection: new Set(),
  } as unknown as RoomTestState;
  return { get: () => state, state: () => state };
}

export function joiner(doc: RoomDoc, blobStore: collab.MemoryBlobStore, roomId: string) {
  const store = recipientState(roomId);
  const notices: string[] = [];
  const deps: RoomReconstructDeps = {
    roomId,
    session: fakeSession(doc),
    collab,
    geomApi,
    sweepApi,
    blobStore,
    parseIfcx: (buffer) => parseIfcxViewerModel(buffer, undefined, { allowEmptyGeometry: true }),
    get: () => store.get() as unknown as RoomReconstructState,
    setRoomModels: (models) => {
      store.get().collabRoomModels = models;
    },
    notify: (m) => notices.push(m),
    applied: () => ({ loc: new Map(), yaw: new Map() }),
    reconcile: () => {},
  };
  return { reconstructor: createRoomReconstructor(deps), store, notices };
}

/**
 * The recipient's store allocates its own dense express ids in IFCX node
 * order, so the owner's `WALL_ID` means nothing there: find the wall by the
 * one identity that survives the room, its (slot-qualified) path-as-GlobalId.
 */
export function localIdOf(model: { ifcDataStore: IfcDataStore | null; maxExpressId: number }, path: string): number {
  const store = model.ifcDataStore;
  assert.ok(store);
  for (let id = 0; id <= model.maxExpressId; id++) {
    if (store.entities.getGlobalId(id) === path) return id;
  }
  throw new Error(`no entity at ${path}`);
}

export function texturePixel(mesh: MeshData): number[] {
  const tex = mesh.texture;
  assert.ok(tex, 'hydrated mesh carries its texture');
  return Array.from(tex.rgba.slice(0, 3));
}
