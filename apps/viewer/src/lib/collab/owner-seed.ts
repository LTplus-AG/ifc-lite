/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The owner's seed-into-room (plan §4.6), lifted out of `collabSlice.startCollab`.
 *
 * Runs once the session has synced, once per model of the share scope, each
 * into the room slot `startCollab` assigned it (#4444): structure first, then
 * geometry as content-addressed mesh blobs, then — after every model — the
 * seed marker that lets joiners tell "nothing to seed" from "seed never
 * arrived". Each model is seeded from ITS OWN store and meshes, so two loaded
 * copies of the same file land as two entity sets with two geometry sets.
 *
 * Per slot, two independent guards keep re-seeding safe:
 *   - structure is seeded once — a slot that already has a record in the
 *     room's `models` map is never re-seeded, so a populated room or a peer's
 *     edits are never clobbered;
 *   - geometry is seeded whenever the slot's entities carry no geometry refs
 *     yet, DECOUPLED from the structure guard so a partially seeded room
 *     backfills. Blobs are content-addressed, so re-seeding dedupes.
 *
 * A room that holds entities but no slot records was shared before slots
 * existed; nothing is seeded into it (an owner never re-shares into an old
 * room — every share mints a fresh room id — so this is a guard, not a path).
 *
 * Reports its progress through `onPhase` / `onProgress` and returns the phase
 * the seed settled in (#4446): the slice mirrors those into `collabSeedPhase`
 * so the Share dialog can hold the invite back until the room actually holds
 * every model. Every store write stays in the slice; this module only computes.
 *
 * The collab runtime is injected (never imported at module scope) so the
 * feature stays code-split — see the import note in collabSlice.ts.
 */

import type { BlobStore, CollabSession, ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { seedGeometryToRoom, type CollabGeomApi, type SeedGeometryReport } from './geometry-sync';
import {
  classifySeed,
  interruptedSeedMarker,
  markerFromReport,
  seedFailureMessage,
  writeGeometrySeedMarker,
} from './geometry-seed-signal';
import { buildStepSeedSource } from './step-seed';
import { pathForEntity, registerEntityMaps, registerStoreSlot } from './entity-paths';
import { pathInRoomSlot } from './model-slot-ref';
import { seedPhaseFromOutcome, type CollabSeedProgress } from './seed-phase';

/**
 * One model of a share (#4444). Carries the model's OWN parsed store plus
 * enough context to seed both schema families:
 *   - IFC5/IFCX → seed natively from the store's own IFCX bytes (`store.source`)
 *     and key geometry by IFCX path (`idToPath`), since an IFCX-origin store has
 *     no STEP `entityIndex.byId`/GUIDs to drive `buildStepSeedSource`.
 *   - legacy STEP → seed an IFCX-shaped `buildStepSeedSource`, key geometry by
 *     `pathForEntity` (slot-qualified GUID path) from `meshes`.
 */
export interface CollabSeedModel {
  /** The viewer model id — the room slot is keyed to it (`collabRoomModels`). */
  modelId: string;
  /** Display name recorded on the slot (the recipient's model name). */
  name: string;
  /** The model's parsed store. For IFC5, `store.source` holds the IFCX bytes. */
  store: IfcDataStore;
  /** True when the model is IFC5/IFCX (seed natively from `store.source`). */
  isIfcx: boolean;
  /**
   * The model's tessellated meshes, for legacy STEP (`null` for IFC5, which
   * re-parses its own bytes). They carry federation GLOBAL ids, i.e. local
   * express id + `idOffset`, exactly as the record holds them.
   */
  meshes: readonly MeshData[] | null;
  idOffset: number;
  schemaVersion?: string;
  fileName?: string;
  sourceFingerprint?: string;
}

/** Model-share payload the owner hands to `startCollab`: the share scope, in slot order. */
export interface CollabSeedInput {
  models: CollabSeedModel[];
}

/** The slice of the collab runtime this needs, off the lazy-loaded `@ifc-lite/collab`. */
export type OwnerSeedRuntime = Pick<
  typeof import('@ifc-lite/collab'),
  | 'seedFromIfcx'
  | 'seedFromStep'
  | 'createModelSlot'
  | 'getModelSlot'
  | 'iterEntities'
  | 'getGeometryRef'
  | 'prefixPathForSlot'
>;

export interface OwnerSeedDeps {
  session: CollabSession;
  /** The share scope, in slot order. */
  seed: CollabSeedInput;
  collab: OwnerSeedRuntime;
  geomApi: CollabGeomApi;
  /** Lazily created: a share of structure-only models never opens the blob store. */
  makeBlobStore: () => Promise<BlobStore>;
  /** The viewer's IFCX importer, lazy-loaded by the caller (code-split). */
  parseIfcx: (buffer: ArrayBuffer) => Promise<ViewerModelPayload>;
  /** Slot per model id, as `startCollab` recorded them before any await. */
  roomModels: ReadonlyMap<string, ModelSlotRef>;
  /**
   * Records the placement each entity's blob is baked at (so every client can
   * render `blob + (current xformop − baseline)`) and returns the path unchanged.
   */
  stampBaseline: (path: string | null) => string | null;
  /** False once this join was abandoned (a newer start/stop ran); stops all writes. */
  isCurrent: () => boolean;
  onPhase: (phase: 'structure' | 'geometry') => void;
  onProgress: (progress: CollabSeedProgress) => void;
}

export interface OwnerSeedResult {
  phase: 'ready' | 'partial' | 'failed';
  /** Owner-facing message for a share that did not fully land, else `null`. */
  failure: string | null;
}

/** View a `Uint8Array` as an `ArrayBuffer` (copying only when it's a sub-view). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? (u8.buffer as ArrayBuffer)
    : (u8.slice().buffer as ArrayBuffer);
}

/** Sum per-model reports into the one the room's seed marker records. */
function mergeSeedReports(reports: readonly SeedGeometryReport[]): SeedGeometryReport | null {
  if (reports.length === 0) return null;
  const out: SeedGeometryReport = {
    offered: 0,
    attempted: 0,
    seeded: 0,
    failed: 0,
    skipped: { noPath: 0, noEntity: 0, empty: 0 },
    abandoned: false,
  };
  for (const r of reports) {
    out.offered += r.offered;
    out.attempted += r.attempted;
    out.seeded += r.seeded;
    out.failed += r.failed;
    out.skipped.noPath += r.skipped.noPath;
    out.skipped.noEntity += r.skipped.noEntity;
    out.skipped.empty += r.skipped.empty;
    out.abandoned = out.abandoned || r.abandoned;
    if (out.error === undefined && r.error !== undefined) out.error = r.error;
  }
  return out;
}

/** Whether any entity of `slot` already carries a geometry ref. */
function slotHasGeometry(deps: OwnerSeedDeps, slot: ModelSlotRef): boolean {
  const doc = deps.session.doc;
  for (const [path] of deps.collab.iterEntities(doc)) {
    if (!pathInRoomSlot(slot, path)) continue;
    const ref = deps.collab.getGeometryRef(doc, path);
    if (ref && ref.geomIds.length > 0) return true;
  }
  return false;
}

/**
 * Seed one model into its slot: structure once, geometry whenever the slot
 * has none. Returns the geometry report, `null` when no upload ran (the slot
 * already had geometry, or the model had nothing to offer), and whether
 * anything was written at all.
 */
async function seedModel(
  deps: OwnerSeedDeps,
  model: CollabSeedModel,
  slot: ModelSlotRef,
  order: number,
  count: number,
  blobs: () => Promise<BlobStore>,
): Promise<{ report: SeedGeometryReport | null; wrote: boolean }> {
  const { session, collab, geomApi } = deps;
  const doc = session.doc;
  const store = model.store;
  let wrote = false;
  registerStoreSlot(store, slot);

  // ── Structure: once per slot. ──
  if (!collab.getModelSlot(doc, slot.slotId)) {
    deps.onPhase('structure');
    wrote = true;
    session.transact(() => {
      collab.createModelSlot(doc, slot.slotId, {
        name: model.name,
        fileName: model.fileName,
        schemaVersion: model.schemaVersion,
        order,
        sourceFingerprint: model.sourceFingerprint,
      });
    });
    if (model.isIfcx) {
      // IFC5: seed natively from the model's own IFCX bytes. The STEP path
      // (buildStepSeedSource) can't read an IFCX-origin store (no
      // entityIndex.byId / GUIDs) and would seed zero entities.
      // Whole-file consumer: the IFCX seed re-parses the source.
      const bytes = store.source;
      if (bytes.length > 0) collab.seedFromIfcx(doc, bytes.materialize(), { slot });
    } else {
      collab.seedFromStep(doc, buildStepSeedSource(store, model.name, slot), { slot });
    }
  }

  // ── Geometry: whenever the slot has none yet. ──
  if (slotHasGeometry(deps, slot)) return { report: null, wrote };
  const opts = {
    onProgress: (uploaded: number, total: number) =>
      deps.onProgress({ uploaded, total, modelIndex: order, modelCount: count }),
  };
  if (model.isIfcx) {
    if (!store.source || store.source.length === 0) return { report: null, wrote };
    // IFCX geometry is explicit in the file: re-parse the source for COMPLETE
    // meshes + the id->path map to key them. (The owner's render buffers may
    // be memory-released for large models, so we never read those for
    // seeding, plan Fix 2.) The file's paths are re-homed under the slot by
    // the runtime's own rule, exactly as `seedFromIfcx` re-homed the entities.
    const parsed = await deps.parseIfcx(toArrayBuffer(store.source.materialize()));
    const idToPath = new Map<number, string>();
    const pathToId = new Map<string, number>();
    if (parsed.idToPath) {
      for (const [id, path] of parsed.idToPath) {
        const qualified = collab.prefixPathForSlot(slot, path);
        idToPath.set(id, qualified);
        pathToId.set(qualified, id);
      }
      // Let the owner's outbound mirror resolve paths on this IFCX store.
      registerEntityMaps(store, idToPath, pathToId);
    }
    const meshes = parsed.geometryResult.meshes;
    if (meshes.length === 0) return { report: null, wrote };
    deps.onPhase('geometry');
    const report = await seedGeometryToRoom(
      geomApi,
      session,
      await blobs(),
      meshes,
      (id) => deps.stampBaseline(idToPath.get(id) ?? null),
      opts,
    );
    return { report, wrote: true };
  }
  if (!model.meshes || model.meshes.length === 0) return { report: null, wrote };
  deps.onPhase('geometry');
  // A federated model's meshes carry federation GLOBAL ids
  // (`applyFederationOffsetToMesh`); the store's paths are keyed by the
  // model's LOCAL express ids.
  const offset = model.idOffset;
  const report = await seedGeometryToRoom(
    geomApi,
    session,
    await blobs(),
    model.meshes,
    (id) => deps.stampBaseline(pathForEntity(store, id - offset)),
    opts,
  );
  return { report, wrote: true };
}

/**
 * Seed the owner's models into the room. Resolves `null` when the join was
 * abandoned before the seed could run (nothing was written, nothing to report).
 * Never throws: a seed that blows up mid-way is reported as `'failed'` and
 * stamped into the room as interrupted, because "the room may hold a partial
 * model" is a fact the Share dialog has to act on rather than a rejection it
 * can swallow (that swallowing is how a weeks-long geometry outage went unseen).
 */
export async function runOwnerSeed(deps: OwnerSeedDeps): Promise<OwnerSeedResult | null> {
  const { session } = deps;
  try {
    await session.whenSynced;
    if (!deps.isCurrent()) return null;
    const models = deps.seed.models;
    if (models.length === 0) return { phase: 'ready', failure: null };
    const doc = session.doc;
    if (doc.getMap('entities').size > 0 && doc.getMap('models').size === 0) {
      // eslint-disable-next-line no-console
      console.warn('[collab] room was shared before model slots existed; not seeding into it');
      return { phase: 'ready', failure: null };
    }

    let blobStore: BlobStore | null = null;
    const blobs = async (): Promise<BlobStore> => (blobStore ??= await deps.makeBlobStore());
    const reports: SeedGeometryReport[] = [];
    let wroteAny = false;
    for (const [order, model] of models.entries()) {
      const slot = deps.roomModels.get(model.modelId);
      if (!slot) {
        // eslint-disable-next-line no-console
        console.error('[collab] seed model has no room slot:', model.modelId);
        continue;
      }
      const { report, wrote } = await seedModel(deps, model, slot, order, models.length, blobs);
      wroteAny = wroteAny || wrote;
      if (report) reports.push(report);
    }
    // Every slot already held its model (a re-join of a seeded room): nothing
    // was added, and the marker the original seed stamped stands.
    if (!wroteAny) return { phase: 'ready', failure: null };

    // Stamp intent vs outcome into the room. Without it a joiner sees the
    // same empty `geometry` map either way and cannot tell a geometry-less
    // model from a failed upload. `null` means no model had geometry to
    // offer — a legitimate share (structure-only or empty models) — which is
    // NOT the same as a seed that ran and landed nothing. Only here, on the
    // owner, is that difference still knowable.
    const report = mergeSeedReports(reports);
    session.transact(() => {
      writeGeometrySeedMarker(session.doc, markerFromReport(report, new Date().toISOString()));
    });
    const failure = seedFailureMessage(report);
    if (failure) {
      // eslint-disable-next-line no-console
      console.error('[collab] geometry seed incomplete:', failure, report);
    }
    return { phase: seedPhaseFromOutcome(classifySeed(report)), failure };
  } catch (err) {
    // A throw here means the seed did not complete: the room may hold a
    // partial model or none at all. Never let the Share dialog call that a
    // success.
    // eslint-disable-next-line no-console
    console.error('[collab] model seeding failed:', err);
    // Tell joiners too. This path never learned how much geometry the model
    // had, so the marker records "interrupted" rather than "expected: 0",
    // which would read as the legitimate nothing-to-seed case and silence
    // the very warning this room needs.
    if (deps.isCurrent()) {
      try {
        session.transact(() => {
          writeGeometrySeedMarker(session.doc, interruptedSeedMarker(new Date().toISOString()));
        });
      } catch (markerErr) {
        // eslint-disable-next-line no-console
        console.error('[collab] could not record the interrupted seed:', markerErr);
      }
    }
    return {
      phase: 'failed',
      failure: 'Sharing this model did not complete. People joining this link may see an incomplete model.',
    };
  }
}
