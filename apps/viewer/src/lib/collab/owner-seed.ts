/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The owner's seed-into-room (plan §4.6), lifted out of `collabSlice.startCollab`.
 *
 * Runs once the session has synced: structure first (only into an empty room,
 * so a populated room or a peer's edits are never clobbered), then geometry as
 * content-addressed mesh blobs (whenever the room has none yet — decoupled from
 * the entity guard so a partially-seeded room backfills), then the seed marker
 * that lets joiners tell "nothing to seed" from "seed never arrived".
 *
 * Reports its progress through `onPhase` / `onProgress` and returns the phase
 * the seed settled in (#4446): the slice mirrors those into `collabSeedPhase`
 * so the Share dialog can hold the invite back until the room actually holds
 * the model. Every store write stays in the slice; this module only computes.
 *
 * The collab runtime is injected (never imported at module scope) so the
 * feature stays code-split — see the import note in collabSlice.ts.
 */

import type { BlobStore, CollabSession, StepSeedSource } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { seedGeometryToRoom, type CollabGeomApi, type SeedGeometryReport } from './geometry-sync';
import {
  classifySeed,
  interruptedSeedMarker,
  markerFromReport,
  seedFailureMessage,
  writeGeometrySeedMarker,
} from './geometry-seed-signal';
import { pathForEntity, registerEntityMaps } from './mutation-bridge';
import { seedPhaseFromOutcome } from './seed-phase';

/**
 * Model-share payload the owner hands to `startCollab`. Carries the parsed
 * store plus enough context to seed both schema families:
 *   - IFC5/IFCX → seed natively from the store's own IFCX bytes (`store.source`)
 *     and key geometry by IFCX path (`idToPath`), since an IFCX-origin store has
 *     no STEP `entityIndex.byId`/GUIDs to drive `buildStepSeedSource`.
 *   - legacy STEP → seed the pre-built IFCX-shaped `stepSource`, key geometry by
 *     `pathForEntity` (GUID path).
 */
export interface CollabSeedInput {
  /** The active model's parsed store. For IFC5, `store.source` holds the IFCX bytes. */
  store: IfcDataStore;
  /** True when the model is IFC5/IFCX (seed natively from `store.source`). */
  isIfcx: boolean;
  /** Pre-built STEP seed source for legacy rooms; `null` for IFC5. */
  stepSource: StepSeedSource | null;
}

/** The two runtime seeders this needs, off the lazy-loaded `@ifc-lite/collab`. */
export type OwnerSeedRuntime = Pick<typeof import('@ifc-lite/collab'), 'seedFromIfcx' | 'seedFromStep'>;

export interface OwnerSeedDeps {
  session: CollabSession;
  /** Lazily produces the seed; `null` means the model has nothing to offer. */
  seed: () => CollabSeedInput | null;
  collab: OwnerSeedRuntime;
  geomApi: CollabGeomApi;
  makeBlobStore: () => Promise<BlobStore>;
  /** Meshes for the legacy STEP path (the owner's live geometry). */
  stepMeshes: () => readonly MeshData[] | undefined;
  /**
   * Records the placement each entity's blob is baked at (so every client can
   * render `blob + (current xformop − baseline)`) and returns the path unchanged.
   */
  stampBaseline: (path: string | null) => string | null;
  /** False once this join was abandoned (a newer start/stop ran); stops all writes. */
  isCurrent: () => boolean;
  onPhase: (phase: 'structure' | 'geometry') => void;
  onProgress: (uploaded: number, total: number) => void;
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

/**
 * Seed the owner's model into the room. Resolves `null` when the join was
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
    const seedData = deps.seed();
    if (!seedData) return { phase: 'ready', failure: null };
    const { store } = seedData;

    // Structure seed — once; never clobber a populated room or peer edits.
    if (session.doc.getMap('entities').size === 0) {
      deps.onPhase('structure');
      if (seedData.isIfcx) {
        // IFC5: seed natively from the model's own IFCX bytes. The STEP path
        // (buildStepSeedSource) can't read an IFCX-origin store (no
        // entityIndex.byId / GUIDs) and would seed zero entities.
        // Whole-file consumer: the IFCX seed re-parses the source.
        const bytes = store.source;
        if (bytes.length > 0) {
          deps.collab.seedFromIfcx(session.doc, bytes.materialize());
        }
      } else if (seedData.stepSource) {
        deps.collab.seedFromStep(session.doc, seedData.stepSource);
      }
    }

    // Geometry already in the room (a re-join of a seeded room): nothing to add.
    if (session.doc.getMap('geometry').size > 0) return { phase: 'ready', failure: null };

    deps.onPhase('geometry');
    const blobStore = await deps.makeBlobStore();
    // `null` means no seed ran at all: the model had nothing to offer. That is
    // a legitimate share (structure-only or empty model) and is NOT the same
    // as a seed that ran and landed nothing, which is a broken share. Only
    // here, on the owner, is that difference still knowable.
    let report: SeedGeometryReport | null = null;
    const opts = { onProgress: deps.onProgress };
    if (seedData.isIfcx && store.source && store.source.length > 0) {
      // IFCX geometry is explicit in the file: re-parse the source for
      // COMPLETE meshes + the id->path map to key them. (The owner's render
      // buffers may be memory-released for large models, so we never read
      // those for seeding, plan Fix 2.)
      const { parseIfcxViewerModel } = await import('@/hooks/ingest/viewerModelIngest');
      const parsed = await parseIfcxViewerModel(toArrayBuffer(store.source.materialize()), undefined, {
        allowEmptyGeometry: true,
      });
      if (parsed.idToPath && parsed.pathToId) {
        // Let the owner's outbound mirror resolve paths on this IFCX store.
        registerEntityMaps(store, parsed.idToPath, parsed.pathToId);
      }
      const meshes = parsed.geometryResult.meshes;
      if (meshes.length > 0) {
        report = await seedGeometryToRoom(
          deps.geomApi,
          session,
          blobStore,
          meshes,
          (id) => deps.stampBaseline(parsed.idToPath?.get(id) ?? null),
          opts,
        );
      }
    } else {
      const meshes = deps.stepMeshes();
      if (meshes && meshes.length > 0) {
        report = await seedGeometryToRoom(
          deps.geomApi,
          session,
          blobStore,
          meshes,
          (id) => deps.stampBaseline(pathForEntity(store, id)),
          opts,
        );
      }
    }
    // Stamp intent vs outcome into the room. Without it a joiner sees the
    // same empty `geometry` map either way and cannot tell a geometry-less
    // model from a failed upload.
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
