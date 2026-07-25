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
  /** Slots currently backed by the typed arrays (grows geometrically toward `capacity`). */
  allocated: number;
}

const caches = new Map<number, ReservoirCache>();

/**
 * Initial slot allocation. Buffers grow geometrically (double, clamped to
 * `capacity`) as points arrive — allocating the full default capacity up
 * front would pin ~24 MB of positions per asset even for a 50k-point PLY.
 */
const INITIAL_SCAN_CACHE_ALLOC = 65_536;

/** Neutral grey written for colorless points once any chunk carries colour. */
const NEUTRAL_COLOR_BYTE = 200;

function createReservoir(capacity: number): ReservoirCache {
  const allocated = Math.min(capacity, INITIAL_SCAN_CACHE_ALLOC);
  return {
    positions: new Float32Array(allocated * 3),
    colors: null,
    classifications: null,
    count: 0,
    seen: 0,
    capacity,
    hasColor: false,
    hasClassifications: false,
    allocated,
  };
}

/**
 * Make sure `slot` is backed. Fill-phase writes are sequential
 * (`slot === count`), so one doubling always reaches the target;
 * replacement-phase writes only start once `count === capacity`, by which
 * point the buffers are fully grown.
 */
function ensureSlotCapacity(cache: ReservoirCache, slot: number): void {
  if (slot < cache.allocated) return;
  const next = Math.min(cache.capacity, Math.max(cache.allocated * 2, slot + 1));
  const positions = new Float32Array(next * 3);
  positions.set(cache.positions);
  cache.positions = positions;
  if (cache.colors) {
    const colors = new Uint8Array(next * 3);
    colors.fill(NEUTRAL_COLOR_BYTE);
    colors.set(cache.colors);
    cache.colors = colors;
  }
  if (cache.classifications) {
    const classes = new Uint8Array(next);
    classes.set(cache.classifications);
    cache.classifications = classes;
  }
  cache.allocated = next;
}

/** Start (or restart) retention for a streamed asset keyed by its renderer handle id. */
export function registerPointCloudScanCache(
  handleId: number,
  capacity: number = DEFAULT_SCAN_CACHE_CAPACITY,
): void {
  // Non-finite capacities are caller bugs with catastrophic failure modes
  // (Infinity → unbounded retention until OOM; NaN → a reservoir that
  // retains nothing). Clamp to the default rather than propagating either.
  const bounded = Number.isFinite(capacity)
    ? Math.max(1, Math.floor(capacity))
    : DEFAULT_SCAN_CACHE_CAPACITY;
  caches.set(handleId, createReservoir(bounded));
}

function ensureColorBuffer(cache: ReservoirCache): Uint8Array {
  if (!cache.colors) {
    cache.colors = new Uint8Array(cache.allocated * 3);
    // Backfill points retained BEFORE the first coloured chunk with the
    // same neutral grey colorless points get going forward — a zero-filled
    // buffer would render them black.
    cache.colors.fill(NEUTRAL_COLOR_BYTE);
  }
  cache.hasColor = true;
  return cache.colors;
}

function ensureClassBuffer(cache: ReservoirCache): Uint8Array {
  if (!cache.classifications) cache.classifications = new Uint8Array(cache.allocated);
  cache.hasClassifications = true;
  return cache.classifications;
}

function writePoint(
  cache: ReservoirCache,
  slot: number,
  chunk: { positions: Float32Array; colors?: Float32Array; classifications?: Uint8Array },
  srcIndex: number,
): void {
  ensureSlotCapacity(cache, slot);
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
