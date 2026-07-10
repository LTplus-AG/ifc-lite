/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU residency policy (issue #1682, phase 3a of the chunked-residency plan).
 *
 * With spatial chunk bucketing (phase 2) a batch is a spatially compact,
 * independently destroyable GPU unit. This module decides WHICH resident
 * batches to evict when the scene exceeds a GPU byte budget. Eviction
 * destroys the batch's GPU buffers but keeps the batch object as a metadata
 * shell (bounds/expressIds/counts) and keeps the bucket's CPU `meshData`, so
 * the batch can be rebuilt on demand when the camera wants it again.
 *
 * Policy (two rules, mirroring the eviction hysteresis in Cesium-class
 * streamers):
 *   1. Never evict a batch drawn this frame — the budget is a target, not a
 *      hard cap; a scene whose visible set alone exceeds the budget renders
 *      correctly and stays over budget (callers may log/telemeter that).
 *   2. Among the rest, evict least-recently-drawn first, and only batches
 *      idle for at least `minAgeFrames` rendered frames — a batch that just
 *      left the frustum during an orbit is likely to come right back, and
 *      re-uploading it every half-gesture would thrash.
 *
 * Pure function over plain shells so the policy is unit-testable without a
 * GPU; the Scene owns the actual destroy/rebuild.
 */

/** Residency view of one bucket-owned batch. */
export interface ResidencyShell {
  /** Bucket key (identifies the bucket to rebuild from). */
  key: string;
  /** GPU bytes this batch holds (vertex + index + uniform). */
  bytes: number;
  /** Scene frame counter value when this batch was last drawn (-1 = never). */
  lastDrawnFrame: number;
}

/** Batches idle for fewer rendered frames than this are never evicted. */
export const MIN_EVICTION_AGE_FRAMES = 30;

/**
 * Select batches to evict so `residentBytes` drops to `budgetBytes` or below.
 * `shells` must contain only ELIGIBLE batches (resident, bucket-owned, CPU
 * geometry retained, not drawn this frame). Returns the keys to evict, LRU
 * first; empty when already within budget or nothing is old enough.
 */
export function selectEvictions(
  shells: readonly ResidencyShell[],
  residentBytes: number,
  budgetBytes: number,
  currentFrame: number,
  minAgeFrames: number = MIN_EVICTION_AGE_FRAMES,
): string[] {
  let excess = residentBytes - budgetBytes;
  if (excess <= 0) return [];

  const candidates = shells
    .filter((s) => currentFrame - s.lastDrawnFrame >= minAgeFrames)
    .sort((a, b) => a.lastDrawnFrame - b.lastDrawnFrame);

  const evict: string[] = [];
  for (const shell of candidates) {
    if (excess <= 0) break;
    evict.push(shell.key);
    excess -= shell.bytes;
  }
  return evict;
}
