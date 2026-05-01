/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Blob garbage collection (open problem #6).
 *
 * Mesh blobs grow without bound during long sessions. This module
 * implements an epoch + reference-count sweep:
 *
 *   1. `collectReferencedBlobHashes(doc)` walks every entity, collects
 *      its `geometryRef.geomId`, then resolves each geometry node to
 *      its `blobHash`. Returns the set of currently-referenced hashes.
 *
 *   2. `planBlobSweep(store, referenced, opts)` returns the list of
 *      blob hashes that exist in `store` but aren't referenced. With
 *      `epochMs` set, only blobs older than that grace window are
 *      candidates — that's the safety valve against deleting a blob a
 *      peer is about to reference but hasn't synced yet.
 *
 *   3. `sweepBlobs(store, decision)` deletes the candidates and reports
 *      bytes freed.
 *
 * GC is correct under sync because: each peer makes blob refs visible
 * via the Y.Doc; once the Y.Doc converges across peers, the
 * referenced-set is the same on every peer. The grace window covers
 * the gap between "blob uploaded" and "Y.Doc reference applied."
 */

import * as Y from 'yjs';
import {
  ENTITY_KEY,
  GEOMETRY_KEY,
  entitiesMap,
  geometryMap,
} from '../doc/schema.js';
import type { BlobHash, BlobMeta, BlobStore } from './blob-store.js';

/**
 * Collect every blob hash currently referenced from a Y.Doc.
 *
 * An entity's `geometryRef.geomId` points at a `geometry` top-level
 * entry whose `blobHash` (if any) we want to keep. We also include any
 * `blobHash` that appears directly in `geometry.params.<*>` so apps
 * that store auxiliary blob refs in params (e.g. textures) survive
 * gc.
 */
export function collectReferencedBlobHashes(doc: Y.Doc): Set<BlobHash> {
  const referenced = new Set<BlobHash>();
  const geom = geometryMap(doc);
  const ents = entitiesMap(doc);

  // 1. From every entity's geometryRef → resolve to a geometry node.
  ents.forEach((entUntyped) => {
    const entity = entUntyped as Y.Map<unknown>;
    const refMap = entity.get(ENTITY_KEY.GEOMETRY_REF) as Y.Map<unknown> | undefined;
    const geomId = refMap?.get('geomId');
    if (typeof geomId !== 'string') return;
    addBlobHashesFromGeometry(geom.get(geomId) as Y.Map<unknown> | undefined, referenced);
  });

  // 2. Also include unreferenced-by-entity geometry entries' blobs —
  //    they are reachable via `geometry` and may get a fresh entity ref
  //    in the next transaction. We *only* sweep blobs that aren't even
  //    in any geometry entry.
  geom.forEach((nodeUntyped) => {
    addBlobHashesFromGeometry(nodeUntyped as Y.Map<unknown>, referenced);
  });

  return referenced;
}

function addBlobHashesFromGeometry(
  node: Y.Map<unknown> | undefined,
  out: Set<BlobHash>,
): void {
  if (!node) return;
  const blobHash = node.get(GEOMETRY_KEY.BLOB_HASH);
  if (typeof blobHash === 'string') out.add(blobHash);
  const params = node.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
  if (!params) return;
  params.forEach((value) => {
    if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) out.add(value);
  });
}

export interface SweepOptions {
  /**
   * Grace window in ms — only blobs older than this are candidates.
   * Default 60_000 (1 minute). Set to 0 to sweep aggressively (tests).
   */
  epochMs?: number;
  /** Override `Date.now` for deterministic tests. */
  now?: () => number;
}

export interface SweepDecision {
  drop: BlobHash[];
  /** Bytes that will be reclaimed once `drop` is processed. May be undefined when the store doesn't expose sizes. */
  reclaimBytes: number;
}

/**
 * Plan a blob sweep against `store`, retaining everything in `referenced`.
 *
 * The store's `list()` returns hashes only; size info comes from a
 * `metaProvider` (default: walks `store.get(hash).byteLength`).
 */
export async function planBlobSweep(
  store: BlobStore,
  referenced: Set<BlobHash>,
  options: SweepOptions & {
    /** Optional fast-path metadata lookup; default streams via `store.get`. */
    metaProvider?: (hash: BlobHash) => Promise<BlobMeta | null>;
  } = {},
): Promise<SweepDecision> {
  const epochMs = options.epochMs ?? 60_000;
  const now = options.now ? options.now() : Date.now();
  const all = await store.list();
  const drop: BlobHash[] = [];
  let reclaim = 0;
  for (const hash of all) {
    if (referenced.has(hash)) continue;
    const meta = options.metaProvider
      ? await options.metaProvider(hash)
      : await metaFromGet(store, hash);
    if (!meta) continue;
    const ageMs =
      meta.uploadedAt != null
        ? Math.max(0, now - new Date(meta.uploadedAt).getTime())
        : Number.POSITIVE_INFINITY;
    if (ageMs >= epochMs) {
      drop.push(hash);
      reclaim += meta.byteLength;
    }
  }
  return { drop, reclaimBytes: reclaim };
}

async function metaFromGet(store: BlobStore, hash: BlobHash): Promise<BlobMeta | null> {
  // Prefer cheap stat() if the backend offers it (size + uploadedAt
  // without paying for the bytes).
  if (typeof store.stat === 'function') {
    const meta = await store.stat(hash);
    if (meta) return meta;
  }
  const bytes = await store.get(hash);
  if (!bytes) return null;
  return {
    hash,
    byteLength: bytes.byteLength,
    // No uploadedAt available via raw bytes — without it, the blob is
    // treated as unbounded-old (always eligible).
  };
}

/** Apply a sweep decision: delete the candidates from `store`. */
export async function sweepBlobs(store: BlobStore, decision: SweepDecision): Promise<number> {
  let freed = 0;
  for (const hash of decision.drop) {
    const ok = await store.delete(hash);
    if (ok) freed += 1;
  }
  void freed;
  return decision.reclaimBytes;
}
