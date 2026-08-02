/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry hydration via content-addressed mesh blobs (plan §4.2 — option b).
 *
 * Owner: encode each tessellated `MeshData`, store it as a blob (the blob hash
 * is the geomId — identical meshes dedupe), and attach a `GeometryRef` to the
 * owning GUID entity in the Y.Doc. Recipient: walk entities' `GeometryRef`s,
 * fetch the blobs, and decode back to `MeshData[]` for the renderer.
 *
 * The collab runtime + blob store are injected so this pulls no collab code
 * eagerly. Re-tessellation (the lighter parametric path, plan §4.2 option a)
 * is a follow-up; mesh blobs are the universal fallback that works for any
 * model including imported meshes.
 *
 * Design note — why blobs, not inline IFCX geometry: even though the rest of
 * the model is reconstructed as IFCX, tessellated geometry stays out-of-band as
 * content-addressed blobs referenced from the doc. This is the USD/IFCX
 * external-reference (payload) pattern, and it keeps the CRDT doc + IFCX
 * snapshot small and bounded (inlining `usd::usdgeom::mesh` into the JSON would
 * bloat both — see the SAB/IFCX memory). The doc holds only the blob hash.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { BlobStore, CollabSession } from '@ifc-lite/collab';
import { decodeMesh, encodeMesh } from './mesh-codec';

/** The collab doc + geometry helpers this module needs (injected). */
export interface CollabGeomApi {
  createGeometry(
    doc: CollabSession['doc'],
    geomId: string,
    opts: { type: 'mesh'; source: string; blobHash?: string },
  ): unknown;
  /** Whether an entity exists at `path` (addGeometryRef throws otherwise). */
  hasEntity(doc: CollabSession['doc'], path: string): boolean;
  /** Append a geomId to an entity's geometry refs (entities can own several meshes). */
  addGeometryRef(doc: CollabSession['doc'], path: string, geomId: string): void;
  /** Replace an entity's geometry refs outright (used by resize — swaps the mesh). */
  setGeometryRef(doc: CollabSession['doc'], path: string, ref: { geomIds: string[] }): void;
  getGeometryRef(doc: CollabSession['doc'], path: string): { geomIds: string[] } | undefined;
  getGeometry(doc: CollabSession['doc'], geomId: string): { get(key: string): unknown } | undefined;
  iterEntities(doc: CollabSession['doc']): IterableIterator<[string, unknown]>;
}

/**
 * Seed tessellated meshes into the room as blobs + per-entity `GeometryRef`s.
 * `pathFor` maps a mesh's `expressId` to its GUID entity path (skipped when it
 * returns null). A single entity can own several meshes (multi-material /
 * multiple representation items), so refs are *appended* per path rather than
 * overwritten. Returns the number of meshes seeded.
 */
export interface SeedGeometryOptions {
  /** Max blob uploads in parallel. Default 16. */
  concurrency?: number;
  /** Upload progress (every ~50 blobs + once at the end), for a share UI. */
  onProgress?: (uploaded: number, total: number) => void;
  /**
   * Replace each entity's geometry refs with the seeded geomIds (via
   * `setGeometryRef`) instead of appending. Used by resize, which swaps a
   * wall's mesh for a freshly-tessellated one — the old blob is left orphaned
   * (no entity refs it) and so isn't hydrated.
   */
  replace?: boolean;
}

export async function seedGeometryToRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
  meshes: readonly MeshData[],
  pathFor: (expressId: number) => string | null,
  opts: SeedGeometryOptions = {},
): Promise<number> {
  // 1. Resolve the seedable meshes up front (valid geometry + entity path + the
  //    owning entity already in the doc), before any network I/O.
  interface SeedJob {
    mesh: MeshData;
    path: string;
  }
  const jobs: SeedJob[] = [];
  let skippedNoPath = 0;
  let skippedEmpty = 0;
  let skippedNoEntity = 0;
  for (const mesh of meshes) {
    // A mesh whose CPU data was released (bounded-geometry mode) carries no
    // triangles — skip it so we don't seed an empty blob that renders nothing.
    if (mesh.positions.length === 0 || mesh.indices.length === 0) {
      skippedEmpty++;
      continue;
    }
    const path = pathFor(mesh.expressId);
    if (!path) {
      skippedNoPath++;
      continue;
    }
    // The owning entity must already be in the doc (the structure seed creates
    // it). Skip rather than let addGeometryRef throw and abort the whole seed —
    // a non-zero count here means structure seeding missed some products.
    if (!api.hasEntity(session.doc, path)) {
      skippedNoEntity++;
      continue;
    }
    jobs.push({ mesh, path });
  }

  // 2. Upload blobs with bounded concurrency. This was one-at-a-time, which took
  //    *minutes* for a large model (thousands of serial network PUTs) and was the
  //    main reason recipients saw geometry trickle in. Content-addressed, so
  //    identical meshes dedupe server-side. Collect (path, hash) for step 3.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 16, jobs.length || 1));
  const refs: { path: string; hash: string }[] = [];
  let nextJob = 0;
  let uploaded = 0;
  const worker = async (): Promise<void> => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      const meta = await blobStore.put(encodeMesh(job.mesh), 'application/octet-stream');
      refs.push({ path: job.path, hash: meta.hash });
      uploaded++;
      if (opts.onProgress && uploaded % 50 === 0) opts.onProgress(uploaded, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 3. Record geometry + refs in the doc — local Yjs ops (fast), batched into a
  //    single transaction so peers receive one update instead of thousands.
  session.transact(() => {
    for (const { path, hash } of refs) {
      api.createGeometry(session.doc, hash, { type: 'mesh', source: 'mesh-blob', blobHash: hash });
    }
    if (opts.replace) {
      // Group hashes per path, then replace each entity's refs in one write.
      const byPath = new Map<string, string[]>();
      for (const { path, hash } of refs) {
        const list = byPath.get(path) ?? [];
        list.push(hash);
        byPath.set(path, list);
      }
      for (const [path, geomIds] of byPath) api.setGeometryRef(session.doc, path, { geomIds });
    } else {
      for (const { path, hash } of refs) api.addGeometryRef(session.doc, path, hash);
    }
  });
  opts.onProgress?.(jobs.length, jobs.length);

  const count = refs.length;
  if (skippedNoPath > 0 || skippedEmpty > 0 || skippedNoEntity > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[collab] seedGeometryToRoom: seeded ${count}/${meshes.length} meshes — ` +
        `${skippedNoPath} skipped (no entity path), ` +
        `${skippedNoEntity} skipped (entity not seeded in doc), ` +
        `${skippedEmpty} skipped (empty/memory-released geometry).`,
    );
  }
  return count;
}

/**
 * Reconstruct `MeshData[]` from the room's geometry blobs, keyed by entity. A
 * recipient that joined a seed-into-room link has no source file, so it walks
 * every entity's `GeometryRef`s, fetches the referenced blobs, and decodes
 * them back to meshes. Walking by entity path (rather than the geometry store)
 * lets us re-key each mesh's `expressId` into the recipient's own id space via
 * `pathToId` — the recipient reconstructs its `IfcDataStore` from the same
 * IFCX snapshot, so `pathToId.get(path)` is the entity's reconstructed
 * expressId, which makes 3D selection resolve to the right inspector entry.
 * Without `pathToId` (e.g. tests), the blob's embedded expressId is kept.
 * Missing blobs are skipped (the seed may still be syncing).
 *
 * Blobs are fetched with bounded concurrency (not one-at-a-time, which left a
 * large model blank for a minute+) and decoded meshes are memoised by geomId in
 * `opts.cache` so a later re-hydrate (e.g. after a peer edit) only fetches the
 * *new* blobs. `opts.onProgress` fires with the growing mesh list so the caller
 * can render incrementally instead of waiting for every blob.
 */
export interface HydrateOptions {
  /** Max blobs fetched in parallel. Default 12. */
  concurrency?: number;
  /** Decoded-mesh cache keyed by geomId, persisted across re-hydrates. */
  cache?: Map<string, MeshData>;
  /** Called as meshes accumulate (throttled by batch), for incremental render. */
  onProgress?: (meshesSoFar: readonly MeshData[]) => void;
}

export async function hydrateGeometryFromRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
  pathToId?: Map<string, number>,
  opts: HydrateOptions = {},
): Promise<MeshData[]> {
  // 1. Collect all (blobHash, expressId, geomId) jobs up front.
  interface Job {
    geomId: string;
    blobHash: string;
    expressId: number | undefined;
  }
  const jobs: Job[] = [];
  for (const [path] of api.iterEntities(session.doc)) {
    const ref = api.getGeometryRef(session.doc, path);
    if (!ref) continue;
    const expressId = pathToId?.get(path);
    for (const geomId of ref.geomIds) {
      const node = api.getGeometry(session.doc, geomId);
      const blobHash = node?.get('blobHash');
      if (typeof blobHash !== 'string') continue;
      jobs.push({ geomId, blobHash, expressId });
    }
  }

  // 2. Fetch + decode with bounded concurrency; serve cache hits without refetch.
  const cache = opts.cache;
  const out: MeshData[] = [];
  let nextJob = 0;
  let sinceProgress = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 12, jobs.length || 1));

  const worker = async (): Promise<void> => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      let base = cache?.get(job.geomId);
      if (!base) {
        // Isolate per-blob failures: a missing/corrupt/half-synced blob must not
        // abort the whole hydrate (which would lose every other mesh).
        try {
          const bytes = await blobStore.get(job.blobHash);
          if (!bytes) continue;
          base = decodeMesh(bytes);
          cache?.set(job.geomId, base);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[collab] skipping geometry blob ${job.blobHash} (fetch/decode failed):`, err);
          continue;
        }
      }
      // Re-key into the recipient id space. Shallow-clone so a cached mesh shared
      // by several entities (instanced geometry) can carry distinct expressIds
      // without mutating the cached copy; the typed arrays are shared (read-only).
      const mesh = job.expressId !== undefined ? { ...base, expressId: job.expressId } : base;
      out.push(mesh);
      if (opts.onProgress && ++sinceProgress >= 50) {
        sinceProgress = 0;
        opts.onProgress(out);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (opts.onProgress) opts.onProgress(out);
  return out;
}

/**
 * Wrap hydrated meshes into a `GeometryResult` the renderer accepts. Meshes
 * arrive already in the owner's shifted coordinate space; we compute bounds +
 * totals for camera framing. Vertices may be in a per-element local frame
 * (`MeshData.origin`, world = origin + position, #1114), so the origin is
 * folded into the bounds.
 *
 * KNOWN FRAME MISMATCH — georeferenced collab (needs follow-up):
 *   For a georeferenced model the owner's world coordinates are reconstructed as
 *   `world = shifted + originShift (+ wasmRtcOffset)` (see coordinate-handler
 *   `toWorld`). The blob meshes are in the owner's SHIFTED frame, but the owner's
 *   `originShift` / `wasmRtcOffset` are NOT transmitted in the room:
 *     - the mesh-codec (mesh-codec.ts) only carries the per-element local
 *       `origin`, never the global shift/rtc;
 *     - `seedGeometryToRoom` seeds mesh blobs only;
 *     - the joiner's IFCX re-parse (viewerModelIngest.ts) hardcodes
 *       `createCoordinateInfo(bounds)` with a zero shift too.
 *   So we can only report zeros here. For a georeferenced model this leaves the
 *   joiner's reconstructed world frame off from the owner's by shift+rtc (up to
 *   ~1e6 m) — wrong georef overlay alignment and wrong coordinate readouts. The
 *   model still renders self-consistently (all meshes share the shift), so 3D
 *   editing/selection is unaffected; only absolute world positioning is wrong.
 *   Proper fix (larger, touches the published @ifc-lite/collab room schema):
 *   have the owner encode its coordinateInfo (originShift + wasmRtcOffset) into
 *   the room at seed time and consume it here instead of the zeros below.
 */
export function buildGeometryResultFromMeshes(meshes: MeshData[]): GeometryResult {
  let totalTriangles = 0;
  let totalVertices = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const m of meshes) {
    totalTriangles += m.indices.length / 3;
    totalVertices += m.positions.length / 3;
    const [ox, oy, oz] = m.origin ?? [0, 0, 0];
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const x = ox + m.positions[i], y = oy + m.positions[i + 1], z = oz + m.positions[i + 2];
      if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
      if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    }
  }
  const bounds = meshes.length
    ? { min, max }
    : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const zero = { x: 0, y: 0, z: 0 };
  return {
    meshes,
    totalTriangles,
    totalVertices,
    coordinateInfo: {
      originShift: zero,
      originalBounds: bounds,
      shiftedBounds: bounds,
      hasLargeCoordinates: false,
    },
  };
}
