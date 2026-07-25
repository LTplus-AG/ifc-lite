/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU-side retained sample of streamed (LAS/LAZ/...) point clouds, for the
 * 2D section scan layer (issue #1805).
 *
 * Streamed scans go straight from the decode worker to the GPU
 * (`ingestPointCloud` in `pointCloudIngest.ts`) — positions are never kept
 * in JS, so there is nothing for the 2D section view to read back from. A
 * full-resolution CPU copy of a multi-hundred-million-point scan isn't
 * viable either, so this module keeps a bounded, uniformly-random SAMPLE
 * per asset via reservoir sampling (Algorithm R): a single streaming pass,
 * no need to know the total point count up front, and every point seen so
 * far has equal probability of being in the final reservoir.
 *
 * This is a plain module-level cache (not viewer store state) — a few
 * million points of positions/colors/classifications would be an expensive
 * thing to push through Zustand on every streamed chunk. `useScanSectionLayer`
 * reads it directly via {@link getPointCloudScanSample}.
 *
 * Lifecycle: `registerPointCloudScanCache` on stream start,
 * `addPointsToScanCache` per chunk, `removePointCloudScanCache` on stream
 * error or when `usePointCloudLifecycle` frees the GPU asset for a removed
 * model — mirroring the classification-histogram cleanup already done
 * there so this cache can't outlive its point cloud.
 */

/** Points retained per asset by default — ~16 bytes/point (pos+color+class) ≈ 32 MB at the cap. */
export const DEFAULT_SCAN_CACHE_CAPACITY = 2_000_000;

export interface RetainedPointCloudSample {
  positions: Float32Array;
  colors: Uint8Array | null;
  classifications: Uint8Array | null;
  /** Points actually held in the reservoir (<= capacity). */
  count: number;
  /** Total points offered to the reservoir so far (for diagnostics only). */
  seen: number;
  capacity: number;
}

interface ReservoirCache extends RetainedPointCloudSample {
  hasColor: boolean;
  hasClassifications: boolean;
}

const caches = new Map<number, ReservoirCache>();

function createReservoir(capacity: number): ReservoirCache {
  return {
    positions: new Float32Array(capacity * 3),
    colors: null,
    classifications: null,
    count: 0,
    seen: 0,
    capacity,
    hasColor: false,
    hasClassifications: false,
  };
}

/** Start (or restart) retention for a streamed asset keyed by its renderer handle id. */
export function registerPointCloudScanCache(
  handleId: number,
  capacity: number = DEFAULT_SCAN_CACHE_CAPACITY,
): void {
  caches.set(handleId, createReservoir(Math.max(1, Math.floor(capacity))));
}

function ensureColorBuffer(cache: ReservoirCache): Uint8Array {
  if (!cache.colors) cache.colors = new Uint8Array(cache.capacity * 3);
  cache.hasColor = true;
  return cache.colors;
}

function ensureClassBuffer(cache: ReservoirCache): Uint8Array {
  if (!cache.classifications) cache.classifications = new Uint8Array(cache.capacity);
  cache.hasClassifications = true;
  return cache.classifications;
}

function writePoint(
  cache: ReservoirCache,
  slot: number,
  chunk: { positions: Float32Array; colors?: Float32Array; classifications?: Uint8Array },
  srcIndex: number,
): void {
  cache.positions[slot * 3] = chunk.positions[srcIndex * 3];
  cache.positions[slot * 3 + 1] = chunk.positions[srcIndex * 3 + 1];
  cache.positions[slot * 3 + 2] = chunk.positions[srcIndex * 3 + 2];
  if (chunk.colors) {
    const colors = ensureColorBuffer(cache);
    colors[slot * 3] = clampByte(chunk.colors[srcIndex * 3] * 255);
    colors[slot * 3 + 1] = clampByte(chunk.colors[srcIndex * 3 + 1] * 255);
    colors[slot * 3 + 2] = clampByte(chunk.colors[srcIndex * 3 + 2] * 255);
  } else if (cache.hasColor) {
    const colors = ensureColorBuffer(cache);
    colors[slot * 3] = 200;
    colors[slot * 3 + 1] = 200;
    colors[slot * 3 + 2] = 200;
  }
  if (chunk.classifications) {
    const classes = ensureClassBuffer(cache);
    classes[slot] = chunk.classifications[srcIndex];
  } else if (cache.hasClassifications) {
    ensureClassBuffer(cache)[slot] = 0;
  }
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Offer one decoded chunk's points to the reservoir (Y-up frame — call this
 * with the SAME positions already swapped Z-up→Y-up that get pushed to the
 * GPU, so the retained sample and the rendered scan agree on orientation).
 *
 * Reservoir sampling (Algorithm R): for the i-th point overall (0-based),
 * if the reservoir isn't full yet, append it; otherwise replace a
 * uniformly-random existing slot with probability `capacity / (i + 1)`.
 * Non-deterministic by design (the retained SET may vary run to run) — only
 * the render-time decimation in `scanSectionMath.ts` needs to be
 * deterministic, since that's what the "showing N of M" UI number pins.
 */
export function addPointsToScanCache(
  handleId: number,
  chunk: { positions: Float32Array; colors?: Float32Array; classifications?: Uint8Array; pointCount: number },
): void {
  const cache = caches.get(handleId);
  if (!cache) return;
  const { capacity } = cache;
  for (let i = 0; i < chunk.pointCount; i++) {
    const seenIndex = cache.seen++;
    if (cache.count < capacity) {
      writePoint(cache, cache.count, chunk, i);
      cache.count++;
      continue;
    }
    // Replace slot `j` with probability capacity/(seenIndex+1).
    const j = Math.floor(Math.random() * (seenIndex + 1));
    if (j < capacity) {
      writePoint(cache, j, chunk, i);
    }
  }
}

/** Current retained sample for one asset, or null if never registered / already removed. */
export function getPointCloudScanSample(handleId: number): RetainedPointCloudSample | null {
  return caches.get(handleId) ?? null;
}

/** Drop one asset's retained sample (stream error, or model removal). */
export function removePointCloudScanCache(handleId: number): void {
  caches.delete(handleId);
}

/** Drop every retained sample — used only by tests / full-session resets. */
export function clearAllPointCloudScanCaches(): void {
  caches.clear();
}
