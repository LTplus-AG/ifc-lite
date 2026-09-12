/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The options and the report of `seedGeometryToRoom` (`geometry-sync.ts`),
 * split out to keep that module within its size budget. Re-exported from
 * `geometry-sync.ts`, so importers of the function need not know.
 */

export interface SeedGeometryOptions {
  /** Max blob uploads in parallel. Default 16. */
  concurrency?: number;
  /** Upload progress (every ~50 blobs + once at the end), for a share UI. */
  onProgress?: (uploaded: number, total: number) => void;
  /**
   * Replace each entity's geometry refs with the seeded geomIds (via
   * `setGeometryRef`) instead of appending. Used by resize, which swaps a
   * wall's mesh for a freshly-tessellated one: the old blob is left orphaned
   * (no entity refs it) and so isn't hydrated.
   */
  replace?: boolean;
  /** Extra attempts per blob after the first one fails. Default 2. */
  retries?: number;
  /** Backoff before each retry, in ms. Default `[150, 600]` (index = attempt). */
  retryDelaysMs?: readonly number[];
  /**
   * Stop uploading after this many blobs have failed outright. A store that
   * refuses every write (the collab-server volume running out of inodes did
   * exactly this) would otherwise take `meshes x (1 + retries)` doomed requests
   * before the caller learns anything: 300k+ for a real model. Default 10.
   */
  maxFailures?: number;
}

/**
 * What a seed actually put in the room. The counts are the whole point: only
 * the owner knows how many meshes it *had*, so only the owner can tell "this
 * model has no geometry to share" (`offered === 0`, legitimate) apart from
 * "this model's geometry never made it into the room" (`offered > 0 &&
 * seeded === 0`, broken). Nothing downstream can recover that distinction.
 */
export interface SeedGeometryReport {
  /** Meshes handed to the seed by the caller. */
  offered: number;
  /** Meshes that passed the pre-flight checks and had an upload attempted. */
  attempted: number;
  /** Meshes whose blob landed AND whose ref was recorded in the doc. */
  seeded: number;
  /** Uploads that failed after every retry. */
  failed: number;
  /** Pre-flight skips. Deterministic, so never retried. */
  skipped: {
    /** Mesh's expressId has no entity path. */
    noPath: number;
    /** Owning entity isn't in the doc (structure seed missed it). */
    noEntity: number;
    /** Mesh carries no triangles (CPU data released in bounded-geometry mode). */
    empty: number;
  };
  /** True when the upload phase stopped early on `maxFailures`. */
  abandoned: boolean;
  /** First upload error, for the log. */
  error?: unknown;
}
