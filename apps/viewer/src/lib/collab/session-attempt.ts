/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One `startCollab` call: the per-attempt token and everything that join
 * wires up (doc helpers, render bookkeeping, blob store, cleanups, session).
 *
 * `startCollab` awaits a dozen times between "the user asked to join" and
 * "the session is live", and the user can Leave and rejoin the SAME room in
 * any of those gaps. A room id cannot tell the two joins apart, so a stale
 * continuation used to pass every `collabRoomId === roomId` re-check, wire
 * its listeners into the module-level slots the live join was using, and
 * commit a second session. Each join now owns one `CollabAttempt`:
 * `attempt.live` is the only currency check, a retired attempt can only
 * touch its own object, and anything it registers after retirement is torn
 * down on the spot.
 */

import type { CollabSession, LocalPlacement } from '@ifc-lite/collab';
import type { AnnotationDocApi } from './annotation-sync';
import type { createSharedBlobStore } from './blob-store';
import type { CollabGeomApi } from './geometry-sync';
import type { CollabDocApi } from './mutation-bridge';

type CollabModule = typeof import('@ifc-lite/collab');
type CollabDoc = CollabSession['doc'];
export type SharedBlobStore = Awaited<ReturnType<typeof createSharedBlobStore>>;

/** Placement (move/rotate) helpers captured from the lazy-loaded runtime. */
export interface PlacementApi {
  getEntityPlacement: (doc: CollabDoc, path: string) => LocalPlacement | null;
  setEntityPlacement: (doc: CollabDoc, path: string, p: LocalPlacement) => void;
  getPlacementBaseline: (doc: CollabDoc, path: string) => LocalPlacement | null;
  setPlacementBaseline: (doc: CollabDoc, path: string, p: LocalPlacement) => void;
}

/** Doc helpers captured from the lazy-loaded collab runtime. */
export interface CollabAttemptApis {
  /** Mutation mirror helpers, so synchronous actions can write without re-importing. */
  doc: CollabDocApi;
  placement: PlacementApi;
  /** Annotation (markup) CRDT helpers for the sync bridge. */
  annotation: AnnotationDocApi;
  /** Geometry helpers, so a local create can push its mesh blob into the room. */
  geom: CollabGeomApi;
}

export function collabAttemptApis(collab: CollabModule): CollabAttemptApis {
  return {
    doc: {
      hasEntity: collab.hasEntity,
      setPropertyValue: collab.setPropertyValue,
      deletePropertyValue: collab.deletePropertyValue,
      setAttribute: collab.setAttribute,
      setEntityPlacement: collab.setEntityPlacement,
      deleteEntity: collab.deleteEntity,
      createEntity: (doc, path, options) => {
        collab.createEntity(doc, path, options);
      },
      XFORMOP_KEY: collab.USD_XFORMOP,
      placementFromXformOp: (value) => {
        const xform = value as { transform?: number[][] } | undefined;
        if (!xform || !Array.isArray(xform.transform)) return null;
        return collab.matrixToPlacement(xform.transform);
      },
      PROPERTY_TYPE_NAMES: collab.PROPERTY_TYPE_NAMES,
    },
    placement: {
      getEntityPlacement: collab.getEntityPlacement,
      setEntityPlacement: collab.setEntityPlacement,
      getPlacementBaseline: collab.getPlacementBaseline,
      setPlacementBaseline: collab.setPlacementBaseline,
    },
    annotation: {
      annotationsMap: (doc) => collab.annotationsMap(doc),
      createAnnotation: (doc, id, fields) => collab.createAnnotation(doc, id, fields),
      deleteAnnotation: (doc, id) => collab.deleteAnnotation(doc, id),
      iterAnnotations: (doc) => collab.iterAnnotations(doc),
    },
    geom: {
      createGeometry: (doc, geomId, opts) => collab.createGeometry(doc, geomId, opts),
      hasEntity: (doc, path) => collab.hasEntity(doc, path),
      addGeometryRef: (doc, path, geomId) => collab.addGeometryRef(doc, path, geomId),
      setGeometryRef: (doc, path, ref) => collab.setGeometryRef(doc, path, ref),
      getGeometryRef: (doc, path) => collab.getGeometryRef(doc, path),
      getGeometry: (doc, geomId) => collab.getGeometry(doc, geomId),
      iterEntities: (doc) => collab.iterEntities(doc),
    },
  };
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab] session cleanup failed:', err);
  }
}

export class CollabAttempt {
  /**
   * Renderer-frame translation (Y-up) currently baked into each entity's live
   * mesh, RELATIVE to its baked baseline. Keyed by federation GLOBAL id
   * (`toGlobalIdFromModels`), because a room holds one model per slot (#4444)
   * and two slots can share every local expressId. Lets inbound placement
   * edits push only the *incremental* delta (and avoids re-applying our own
   * edits).
   */
  readonly placementAppliedLoc = new Map<number, [number, number, number]>();
  /** Companion to `placementAppliedLoc`: renderer-frame yaw (radians). */
  readonly placementAppliedYaw = new Map<number, number>();
  apis: CollabAttemptApis | null = null;
  private sessionRef: CollabSession | null = null;
  private retired = false;
  private readonly cleanups: (() => void)[] = [];
  private blobStoreFactory: (() => Promise<SharedBlobStore>) | null = null;
  private blobStorePromise: Promise<SharedBlobStore> | null = null;

  constructor(readonly roomId: string) {}

  /** False once a Leave, a failed start, or a newer join retired this attempt. */
  get live(): boolean {
    return !this.retired;
  }

  get session(): CollabSession | null {
    return this.sessionRef;
  }

  /**
   * Take ownership of the session this attempt created. A retired attempt
   * disposes it on the spot and answers false: nothing still tracks it.
   */
  adopt(session: CollabSession): boolean {
    if (this.retired) {
      runCleanup(() => session.dispose());
      return false;
    }
    this.sessionRef = session;
    return true;
  }

  /** Run `cleanup` when this attempt retires — at once if it already has. */
  onRetire(cleanup: () => void): void {
    if (this.retired) runCleanup(cleanup);
    else this.cleanups.push(cleanup);
  }

  setBlobStoreFactory(factory: () => Promise<SharedBlobStore>): void {
    this.blobStoreFactory = factory;
    this.blobStorePromise = null;
  }

  hasBlobStore(): boolean {
    return this.blobStoreFactory !== null;
  }

  /** This attempt's shared blob store, created once on first use. */
  blobStore(): Promise<SharedBlobStore> {
    const factory = this.blobStoreFactory;
    if (!factory) return Promise.reject(new Error('[collab] no blob store for this session'));
    if (!this.blobStorePromise) {
      const created = factory();
      this.blobStorePromise = created;
      // A failed creation must not be cached: the next push retries.
      created.catch(() => {
        if (this.blobStorePromise === created) this.blobStorePromise = null;
      });
    }
    return this.blobStorePromise;
  }

  /** Tear down everything this attempt wired, then its session. Idempotent. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    if (liveAttempt === this) liveAttempt = null;
    for (const cleanup of this.cleanups.splice(0).reverse()) runCleanup(cleanup);
    const session = this.sessionRef;
    if (session) runCleanup(() => session.dispose());
    this.apis = null;
    this.blobStoreFactory = null;
    this.blobStorePromise = null;
  }
}

let liveAttempt: CollabAttempt | null = null;

/** Start a new join attempt, retiring whichever one was live. */
export function beginCollabAttempt(roomId: string): CollabAttempt {
  liveAttempt?.retire();
  const attempt = new CollabAttempt(roomId);
  liveAttempt = attempt;
  return attempt;
}

/** The attempt the store's collab state belongs to, if any. */
export function liveCollabAttempt(): CollabAttempt | null {
  return liveAttempt;
}
