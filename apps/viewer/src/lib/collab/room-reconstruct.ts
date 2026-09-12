/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recipient side of a share: rebuild every model the room holds, one viewer
 * model per slot (#4444).
 *
 * A recipient (deep-link join, no local model) reconstructs the room from the
 * CRDT as IFCX — the canonical format — one snapshot per slot
 * (`snapshotToIfcx(doc, { slot })` → `parseIfcxViewerModel`), then attaches
 * geometry hydrated from the room's blobs, filtered to that slot's entities.
 * IFC5 rooms carry containment + properties natively; legacy STEP rooms are
 * seeded IFCX-shaped too (see `buildStepSeedSource`), so this single path
 * serves both. A room shared before slots existed reads as one legacy slot
 * (`listModelSlots`), so it reconstructs exactly what it did before, under
 * `room:<roomId>:m0`.
 *
 * Each slot is registered as a real federated model — through
 * `registerModelOffset`, like any file added to the workspace — so its meshes
 * live in their own global id range and two copies of one file, with the same
 * local express ids and the same GlobalIds, are two selectable models. The
 * hydrated meshes are re-homed with `applyFederationOffsetToMesh` exactly as
 * the loader does for an added file.
 *
 * Extracted from `collabSlice.startCollab` (which reconstructed one model at
 * `idOffset: 0`) as a factory over injected dependencies, so the slice stays
 * within its size budget and this can be driven under `tsx --test` against a
 * real document without a websocket. Best-effort — blobs may still be
 * syncing; a later re-join picks up the rest.
 */

import type { BlobStore, CollabSession, LocalPlacement, ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { applyFederationOffsetToMesh } from '@/hooks/ingest/federationOffset';
import { toGlobalIdFromModels } from '@/store/globalId';
import { applyRoomModelData } from './room-model-apply';
import { registerEntityMaps, registerStoreSlot } from './entity-paths';
import { buildGeometryResultFromMeshes, hydrateGeometryFromRoom, type CollabGeomApi } from './geometry-sync';
import { missingRoomGeometryMessage, readGeometrySeedMarker } from './geometry-seed-signal';
import { highestExpressId, raisedMaxExpressId } from './express-id-bounds';
import { clearAppliedPlacements, sweepPlacements, type PlacementSweepApi } from './placement-sweep';
import { pathInRoomSlot, roomModelIdFor } from './model-slot-ref';

/** The slice of the collab runtime the reconstruct needs (injected). */
export type RoomReconstructRuntime = Pick<typeof import('@ifc-lite/collab'), 'snapshotToIfcx' | 'listModelSlots'>;

/** The store actions and reads the reconstruct goes through (a narrow view of `ViewerState`). */
export type RoomReconstructState = Pick<
  ViewerState,
  'collabRoomId' | 'models' | 'upsertModel' | 'updateModel' | 'removeModel' | 'registerModelOffset'
> &
  Parameters<typeof applyRoomModelData>[0];

export interface RoomReconstructDeps {
  roomId: string;
  session: CollabSession;
  collab: RoomReconstructRuntime;
  geomApi: CollabGeomApi;
  sweepApi: PlacementSweepApi;
  blobStore: BlobStore;
  /** The viewer's IFCX importer, lazy-loaded by the caller (code-split). */
  parseIfcx: (buffer: ArrayBuffer) => Promise<ViewerModelPayload>;
  get: () => RoomReconstructState;
  /** Publish the room's models (viewer id → slot) once the slots are known. */
  setRoomModels: (models: Map<string, ModelSlotRef>) => void;
  /** One-shot user notice (the slice routes it to the toast channel). */
  notify: (message: string) => void;
  /** The live placement bookkeeping, keyed by federation GLOBAL id. */
  applied: () => {
    loc: Map<number, [number, number, number]> | null;
    yaw: Map<number, number> | null;
  };
  /** The slice's live reconciler — moves one entity's mesh to `placement`. */
  reconcile: (modelId: string, store: IfcDataStore, entityId: number, placement: LocalPlacement) => void;
}

export interface RoomReconstructor {
  /** Re-derive every slot from the doc (no-op while a run is in flight). */
  reconstruct(): Promise<void>;
  /** Re-run (debounced) whenever a peer edits the doc. */
  attachLive(): void;
  /** Stop listening and drop every model this reconstructor registered. */
  teardown(): void;
}

interface SlotState {
  modelId: string;
  created: boolean;
}

const LIVE_DEBOUNCE_MS = 800;

export function createRoomReconstructor(deps: RoomReconstructDeps): RoomReconstructor {
  const { roomId, session, collab, geomApi, blobStore } = deps;
  const live = (): boolean => deps.get().collabRoomId === roomId;
  const slots = new Map<string, SlotState>();
  let lastGeomSignature = '';
  let reconstructing = false;
  // The missing-geometry warning fires at most once per room: reconstruct
  // re-runs on every peer edit, and a repeating alarm gets tuned out.
  let warnedMissingGeometry = false;
  /** Meshes the last hydrate produced across every slot (0 until one has run). */
  let lastMeshCount = 0;
  // Decoded-mesh cache (geomId → mesh), persisted across re-reconstructs so a
  // later doc update only fetches the *new* blobs, not the whole model. Shared
  // by every slot: geometry is content-addressed, and hydrate hands each
  // consumer its own copy of the vertex arrays.
  const geomCache = new Map<string, MeshData>();

  /** Re-home a hydrate's meshes once each (progress and final lists share objects). */
  const shifted = new WeakSet<MeshData>();
  const rehome = (meshes: readonly MeshData[], idOffset: number): MeshData[] => {
    for (const m of meshes) {
      if (shifted.has(m)) continue;
      shifted.add(m);
      applyFederationOffsetToMesh(m, idOffset);
    }
    return meshes.slice();
  };

  const publishRoomModels = (listed: ModelSlotRef[]): void => {
    const next = new Map<string, ModelSlotRef>();
    for (const slot of listed) next.set(roomModelIdFor(roomId, slot.slotId), slot);
    deps.setRoomModels(next);
  };

  /**
   * "Did the room's geometry change since the last hydrate?" — records AND
   * refs. Geometry is content-addressed, so the second copy of a file whose
   * meshes are byte-identical to the first's adds no record at all: only its
   * entities' refs land. A record count alone read that as "nothing changed"
   * and the second model stayed empty for good.
   */
  const geometrySignature = (): string => {
    let refs = 0;
    for (const [path] of geomApi.iterEntities(session.doc)) {
      refs += geomApi.getGeometryRef(session.doc, path)?.geomIds.length ?? 0;
    }
    return `${session.doc.getMap('geometry').size}:${refs}`;
  };

  /** One slot: snapshot → parse → register/refresh the model, then geometry. */
  const reconstructSlot = async (
    slot: ModelSlotRef & { name: string },
    geometryChanged: boolean,
  ): Promise<{ payload: ViewerModelPayload; state: SlotState } | null> => {
    const ifcxFile = collab.snapshotToIfcx(session.doc, { slot });
    const buffer = new TextEncoder().encode(JSON.stringify(ifcxFile)).buffer as ArrayBuffer;
    const payload = await deps.parseIfcx(buffer);
    if (!live()) return null;
    // Register the IFCX path maps so the recipient's outbound mirror and
    // inbound apply can resolve entity↔path (the reconstructed store has no
    // STEP `entityIndex.byId`). The snapshot's paths are the doc's, already
    // slot-qualified. Without this, recipient edits don't sync.
    if (payload.idToPath && payload.pathToId) {
      registerEntityMaps(payload.dataStore, payload.idToPath, payload.pathToId);
    }
    registerStoreSlot(payload.dataStore, slot);

    const modelId = roomModelIdFor(roomId, slot.slotId);
    let state = slots.get(modelId);
    if (!state) {
      state = { modelId, created: false };
      slots.set(modelId, state);
    }
    // A slot this reconstructor has never built hydrates regardless of the
    // room-wide signal: it can first appear on a later run (the owner seeds
    // slots in order, and a joiner mid-seed sees them land one by one).
    const firstBuild = !state.created;
    if (firstBuild) {
      // First build: register a real model record (like a normal file load),
      // giving the recipient an activeModelId + selection that resolves to a
      // model (not 'legacy') so PropertiesPanel registers an editable
      // MutablePropertyView. The id offset comes from the federation registry
      // like any added file's, so slots never share a global id range.
      state.created = true;
      const maxExpressId = highestExpressId(payload.idToPath);
      const idOffset = deps.get().registerModelOffset(modelId, maxExpressId);
      for (const m of payload.geometryResult.meshes) applyFederationOffsetToMesh(m, idOffset);
      deps.get().upsertModel({
        id: modelId,
        name: slot.name,
        ifcDataStore: payload.dataStore,
        geometryResult: payload.geometryResult,
        visible: true,
        collapsed: false,
        schemaVersion: payload.schemaVersion,
        loadedAt: Date.now(),
        fileSize: 0,
        idOffset,
        maxExpressId,
        loadState: 'complete',
      });
    } else {
      // Re-derivation on a peer edit: refresh the ROOM model's store in place
      // (keeps the model id + activeModelId stable). Addressed by id, not
      // through the bare active-model setter: the recipient may have their
      // own model active (see `applyRoomModelData`), and writing there would
      // replace their file's store with the room's.
      applyRoomModelData(deps.get(), modelId, { ifcDataStore: payload.dataStore });
      // `applyRoomModelData`'s ifcDataStore write leaves `maxExpressId` at
      // whatever the FIRST reconstruct captured (#2719). The re-derive
      // re-allocates dense ids from 1 (`entity-extractor.ts`), so a peer's
      // newly created entity lands ABOVE that frozen bound, and `globalId.ts`
      // gates resolution on `localExpressId <= model.maxExpressId`. Raised,
      // never lowered: ids already handed out elsewhere (selection,
      // annotations) must keep resolving, so the bound is a high-water mark.
      const model = deps.get().models.get(modelId);
      const raised = model ? raisedMaxExpressId(model.maxExpressId, payload.idToPath) : null;
      if (raised !== null) deps.get().updateModel(modelId, { maxExpressId: raised });
    }

    if (geometryChanged || firstBuild) {
      const idOffset = deps.get().models.get(modelId)?.idOffset ?? 0;
      // Only this slot's entities: geometry is walked by entity path, and the
      // paths of every other slot are not this model's.
      const slotApi: CollabGeomApi = {
        ...geomApi,
        iterEntities: function* (doc) {
          for (const entry of geomApi.iterEntities(doc)) {
            if (pathInRoomSlot(slot, entry[0])) yield entry;
          }
        },
      };
      const meshes = await hydrateGeometryFromRoom(slotApi, session, blobStore, payload.pathToId, {
        cache: geomCache,
        onFailure: (message) => {
          if (live()) deps.notify(message);
        },
        onProgress: (soFar) => {
          if (live() && soFar.length > 0) {
            applyRoomModelData(deps.get(), modelId, {
              geometryResult: buildGeometryResultFromMeshes(rehome(soFar, idOffset)),
            });
          }
        },
      });
      lastMeshCount += meshes.length;
      if (live()) {
        applyRoomModelData(deps.get(), modelId, {
          geometryResult:
            meshes.length > 0 ? buildGeometryResultFromMeshes(rehome(meshes, idOffset)) : payload.geometryResult,
        });
      }
    }
    return { payload, state };
  };

  const reconstruct = async (): Promise<void> => {
    if (reconstructing || !live()) return;
    reconstructing = true;
    try {
      const listed = collab.listModelSlots(session.doc);
      publishRoomModels(listed);
      const geomCount = session.doc.getMap('geometry').size;
      const signature = geometrySignature();
      const geometryChanged = signature !== lastGeomSignature;
      if (geometryChanged) {
        lastGeomSignature = signature;
        lastMeshCount = 0;
      }
      const built: Array<{ payload: ViewerModelPayload; state: SlotState }> = [];
      for (const slot of listed) {
        const result = await reconstructSlot(slot, geometryChanged);
        if (!result) return;
        built.push(result);
      }
      if (!live()) return;

      const { loc, yaw } = deps.applied();
      if (geometryChanged) {
        // The meshes just installed are BAKED, i.e. back at
        // `meta.placementBaseline` (hydrate copies the vertex arrays per
        // consumer, so a re-hydrate returns the original geometry rather than
        // a copy the renderer had already translated in place). The
        // applied-placement bookkeeping describes the meshes just replaced,
        // so it is now false — and false in the one direction that silently
        // pins the damage: the sweep below would read "already applied" and
        // leave the entity reverted. Forget it here, AFTER every slot's
        // `await hydrateGeometryFromRoom`: a remote placement event landing
        // during those awaits re-stamps `applied` for a mesh that is
        // discarded by this replacement, and clearing beforehand would let
        // that stale stamp survive into the sweep.
        //
        // SAFE FOR A NON-OBVIOUS REASON: the applied maps are shared with the
        // live placement-event path, so a clear here is only correct if
        // nothing can observe it mid-way. Nothing can — there is no `await`
        // between this clear and the `sweepPlacements` calls below
        // (`collectPlacementDrift` reads the doc synchronously), so the
        // clear-then-sweep pair is one uninterruptible turn of the event
        // loop. Inserting an `await` anywhere in that span reopens the window
        // this comment closes.
        clearAppliedPlacements(loc, yaw);
      }
      // Placement is NOT carried by the blobs: a hydrated mesh sits at the
      // `usd::xformop` it was baked at, and only a live placement *event* ever
      // moved it. So re-derive it from the doc here — for a late joiner (which
      // receives no such event at all), for an event dropped before this
      // model existed, and for the meshes just re-hydrated. Idempotent:
      // `sweepPlacements` skips anything already applied, so this is a no-op
      // on a room where nothing has moved, and it is the ONLY
      // placement-replay mechanism.
      for (const { payload, state } of built) {
        const models = deps.get().models;
        sweepPlacements(
          deps.sweepApi,
          session.doc,
          payload.pathToId,
          loc,
          yaw,
          (entityId, placement) => {
            deps.reconcile(state.modelId, payload.dataStore, entityId, placement);
          },
          (entityId) => toGlobalIdFromModels(models, state.modelId, entityId),
        );
      }
      // Warn about a room that rendered nothing. The old guard was
      // `geomCount > 0`, which cannot fire in the case that actually breaks a
      // room: a failed upload leaves no geometry records at all. The owner's
      // seed marker is what separates that from a legitimately geometry-less
      // model. Checked OUTSIDE the geometry-changed guard because the marker
      // can land on its own, with no geometry record to change (that is
      // precisely the failed seed), and would otherwise never be looked at.
      if (!warnedMissingGeometry) {
        const missing = missingRoomGeometryMessage({
          marker: readGeometrySeedMarker(session.doc),
          geometryRecords: geomCount,
          hydratedMeshes: lastMeshCount,
        });
        if (missing && live()) {
          warnedMissingGeometry = true;
          // eslint-disable-next-line no-console
          console.warn(`[collab] recipient: ${missing}`);
          deps.notify(missing);
        }
      }
    } finally {
      reconstructing = false;
    }
  };

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  const onDocUpdate = (): void => {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      void reconstruct();
    }, LIVE_DEBOUNCE_MS);
  };

  return {
    reconstruct,
    attachLive: () => {
      session.doc.on('update', onDocUpdate);
    },
    teardown: () => {
      if (debounceHandle) clearTimeout(debounceHandle);
      try {
        session.doc.off('update', onDocUpdate);
      } catch {
        /* cleanup — safe to ignore */
      }
      // Drop the reconstructed room models on leave so rejoining a different
      // room doesn't accumulate stale `room:*` models. (Only the recipient
      // path creates these; the owner shares its own local models.)
      for (const state of slots.values()) {
        if (!state.created) continue;
        try {
          deps.get().removeModel(state.modelId);
        } catch {
          /* cleanup — safe to ignore */
        }
      }
      slots.clear();
    },
  };
}
