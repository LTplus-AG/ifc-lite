/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU spatial index over one point-cloud asset's positions (issue #1860).
 *
 * The measure tool picks by CPU ray-casting triangle meshes
 * (`scene-raycaster.ts` / `raycast-engine.ts`); point clouds never
 * participate because their positions are packed straight into a GPU
 * vertex buffer and discarded (`point-cloud-node.ts` `appendChunkToNode`
 * never retains the source `Float32Array`). This index is built
 * incrementally as chunks stream in (or on the one-shot IFCx upload
 * path) and keeps just enough CPU-side state to answer "which real scan
 * point is closest to this ray, within a screen-space tolerance".
 *
 * Storage: a coarse uniform voxel grid. Points bucket into
 * `floor(coord / cellSize)` cells, keyed by a single packed integer
 * (`packKey`) so the grid is a plain `Map<number, number[]>` — no
 * string hashing, and no need to know the cloud's final extent up
 * front. Keys are packed relative to the FIRST indexed point's cell so
 * they stay exact f64 integers even for un-rebased georeferenced clouds
 * (LV95 / UTM eastings in the millions of metres); see `CELL_KEY_BIAS`.
 *
 * Memory: each inserted chunk's `Float32Array` is kept BY REFERENCE
 * (never copied) — it would otherwise be garbage immediately after
 * `appendChunkToNode` finishes packing it into the GPU buffer, so
 * retaining it here is the only reason it survives. That is an
 * unavoidable 12 bytes/point (three f32) if snapping is to hit real
 * points rather than an approximation. The grid itself adds roughly
 * 8 bytes/point (one array slot per point, across however many cells)
 * plus a small constant per occupied cell — a few MB per million
 * points at typical scan density. See `DEFAULT_MAX_INDEXED_POINTS` for
 * the safety valve on extreme (tens-of-millions-of-points) clouds.
 *
 * Query: `queryRay` walks cells in ray-marching (Amanatides & Woo DDA)
 * order, so cost is O(cells touched along the ray), not O(points) —
 * a query over a 50M-point cloud still only tests a handful of cells.
 */

import type { Vec3 } from '../raycaster.js';

/**
 * Default cell edge, metres. Coarse relative to typical scan spacing
 * (millimetres to a few centimetres) so a query rarely visits more than
 * a handful of cells, while small enough that a query near building
 * scale doesn't degenerate into "search almost everything".
 */
export const DEFAULT_POINTCLOUD_INDEX_CELL_SIZE = 0.5;

/**
 * Hard cap on how many points a single index will hold. Beyond this,
 * further inserted points still upload to the GPU normally (rendering
 * is unaffected) but are simply not indexed, so the measure tool can't
 * snap to them. This is the "last resort" from the design brief: full,
 * uncapped indexing is strongly preferred (snapping wants real points),
 * so this only bites on genuinely extreme clouds — at ~20 bytes/point
 * of CPU overhead (12 bytes retained positions + ~8 bytes grid), 30M
 * points is already ~600 MB of additional retained memory.
 */
export const DEFAULT_MAX_INDEXED_POINTS = 30_000_000;

/**
 * Cap on the per-visited-cell neighborhood dilation radius, in cells
 * (issue #1860 review finding 1). `toleranceAt(t)` GROWS with depth
 * (it's a screen-space pixel tolerance projected to world units), so a
 * fixed +-1 cell dilation (~0.5 * cellSize of perpendicular coverage)
 * silently stops covering the true tolerance once
 * `toleranceAt(t) > cellSize` — which for the measure tool's ~8px
 * tolerance happens around t = 60-130 m depending on canvas/fov, i.e.
 * exactly the zoomed-out site-scale scans where this matters most.
 * `queryRay` instead computes `r = clamp(ceil(toleranceAt(t)/cellSize),
 * 1, MAX_DILATION_RADIUS_CELLS)` at every visited cell and dilates by
 * that many cells. Capped so a single visited cell never tests more
 * than `(2*4+1)^3 = 729` cells worst case; beyond the cap the
 * *effective* snap radius clamps at `MAX_DILATION_RADIUS_CELLS *
 * cellSize` (2 m at the default 0.5 m cell size) instead of growing
 * unbounded with depth.
 */
export const MAX_DILATION_RADIUS_CELLS = 4;

/**
 * Cell coordinates are packed RELATIVE to the first indexed point's cell
 * (`cellOrigin*` below), clamped to ±`CELL_KEY_BIAS` cells per axis. The
 * relative range must be small enough that the packed triple stays an
 * EXACT f64 integer: with a per-axis range of 2^17 the maximum key is
 * (2^17)^3 = 2^51 < 2^53, so distinct cells always get distinct keys.
 * (The previous absolute-coordinate packing used a 2^21 range whose keys
 * reached ~2^62 — beyond f64's 53-bit integer precision, silently
 * merging every z-column of cells within ~1024 cells into one bucket,
 * and additionally aliasing outright for georeferenced clouds beyond
 * ±524 km. Merged buckets stayed *correct* — `testPoint` re-checks real
 * positions — but degraded the query from O(cells) toward O(points).)
 *
 * ±2^16 relative cells at the default 0.5 m cell size covers ±32.7 km
 * around the first point — beyond any physically plausible single scan.
 * Points outside that window clamp onto the boundary cells (they merge
 * buckets there, degrading gracefully instead of breaking).
 */
const CELL_KEY_BIAS = 1 << 16; // 65,536 cells = ±32.7 km at 0.5 m cells
const CELL_KEY_RANGE = CELL_KEY_BIAS * 2; // 2^17 per axis → max key 2^51, f64-exact

/** Clamp a relative cell coordinate into the packable per-axis window. */
function clampRelCell(c: number): number {
  return c < -CELL_KEY_BIAS ? -CELL_KEY_BIAS : c >= CELL_KEY_BIAS ? CELL_KEY_BIAS - 1 : c;
}

/** One inserted chunk: a retained position buffer plus its global-id offset. */
interface IndexedChunk {
  positions: Float32Array;
  /**
   * Per-point LAS classification codes, retained so `queryRay` can skip
   * points the splat shader currently hides via the class visibility
   * mask (#1783) — otherwise the measure tool would snap to invisible
   * scan data. `null` when the source chunk carried no classifications;
   * those points behave as class 0, mirroring the GPU vertex packing
   * (`appendPointSubBuffer` writes class 0 for classification-free
   * chunks, so the shader masks them under bit 0 too).
   */
  classifications: Uint8Array | null;
  count: number;
  /** Global point id of this chunk's point 0 (cumulative across chunks). */
  startId: number;
}

/** Is `classId` visible under a normalized 8-word class bitmask?
 *  (`undefined`/missing words default to visible, matching
 *  `normalizeClassMask`.) */
function classVisible(classMask: Uint32Array | null | undefined, classId: number): boolean {
  if (!classMask) return true;
  const word = classMask[classId >> 5];
  if (word === undefined) return true;
  return ((word >>> (classId & 31)) & 1) === 1;
}

export interface PointCloudRayHit {
  /** World-space position of the snapped point. */
  position: Vec3;
  /** True distance along the ray (world units) to the snapped point. */
  distance: number;
}

/** Axis-aligned ray/box entry+exit distances, or null on a miss. */
function rayBoxEntryExit(
  origin: Vec3,
  dir: Vec3,
  box: { min: Vec3; max: Vec3 },
): { tMin: number; tMax: number } | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  const axes: ReadonlyArray<keyof Vec3> = ['x', 'y', 'z'];
  for (const ax of axes) {
    const o = origin[ax];
    const d = dir[ax];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[ax] || o > box.max[ax]) return null;
      continue;
    }
    let t1 = (box.min[ax] - o) / d;
    let t2 = (box.max[ax] - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  return { tMin, tMax };
}

/**
 * CPU spatial index for one point-cloud asset. Insert incrementally via
 * `insertRange` as chunks stream in; query via `queryRay`. Not thread
 * safe (single-threaded main-thread structure, matching the renderer).
 */
export class PointCloudSpatialIndex {
  private readonly cellSize: number;
  private readonly maxIndexedPoints: number;
  private readonly cells = new Map<number, number[]>();
  private chunks: IndexedChunk[] = [];
  private total = 0;

  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;

  /**
   * Cell coordinates of the first indexed point — the origin every packed
   * cell key is relative to (see `CELL_KEY_BIAS`). Rebasing per index keeps
   * keys f64-exact even for un-rebased georeferenced clouds (e.g. Swiss
   * LV95 eastings ~2.6e6 m → absolute cell ~5.2e6, far outside any
   * absolute packing window, but within ±2^16 cells of the cloud's own
   * first point).
   */
  private cellOriginX = 0;
  private cellOriginY = 0;
  private cellOriginZ = 0;
  private hasCellOrigin = false;

  /** Pack ABSOLUTE cell coordinates into one exact-integer key. */
  private packKey(cx: number, cy: number, cz: number): number {
    const ux = clampRelCell(cx - this.cellOriginX) + CELL_KEY_BIAS;
    const uy = clampRelCell(cy - this.cellOriginY) + CELL_KEY_BIAS;
    const uz = clampRelCell(cz - this.cellOriginZ) + CELL_KEY_BIAS;
    return (ux * CELL_KEY_RANGE + uy) * CELL_KEY_RANGE + uz;
  }

  constructor(
    cellSize: number = DEFAULT_POINTCLOUD_INDEX_CELL_SIZE,
    maxIndexedPoints: number = DEFAULT_MAX_INDEXED_POINTS,
  ) {
    this.cellSize = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : DEFAULT_POINTCLOUD_INDEX_CELL_SIZE;
    this.maxIndexedPoints =
      maxIndexedPoints > 0 && Number.isFinite(maxIndexedPoints)
        ? Math.floor(maxIndexedPoints)
        : DEFAULT_MAX_INDEXED_POINTS;
  }

  /** Total number of points currently indexed (may be less than the
   *  asset's true point count once `maxIndexedPoints` is hit). */
  get pointCount(): number {
    return this.total;
  }

  /** True once further inserts are silently dropped (memory safety valve). */
  get isCapped(): boolean {
    return this.total >= this.maxIndexedPoints;
  }

  /**
   * Insert the first `count` xyz triples of `positions` (renderer/world
   * space — the same frame `queryRay` expects). Keeps `positions` (and
   * `classifications`, when given) BY REFERENCE; the caller must not
   * mutate them afterwards. A no-op past `maxIndexedPoints` (see class
   * docs) — points beyond the cap render normally but are not indexed
   * for picking. When a chunk CROSSES the cap, only the accepted prefix
   * is retained (copied) so the cap genuinely bounds retained memory —
   * keeping the whole source array by reference would retain e.g. a
   * 100M-point one-shot chunk's full 1.2 GB for a 30M-point cap.
   */
  insertRange(positions: Float32Array, count: number, classifications?: Uint8Array | null): void {
    if (count <= 0 || this.total >= this.maxIndexedPoints) return;
    const usable = Math.min(count, this.maxIndexedPoints - this.total);
    const startId = this.total;
    const retainedPositions = usable < count ? positions.slice(0, usable * 3) : positions;
    const retainedClasses = classifications
      ? (usable < count ? classifications.slice(0, usable) : classifications)
      : null;
    this.chunks.push({ positions: retainedPositions, classifications: retainedClasses, count: usable, startId });
    for (let i = 0; i < usable; i++) {
      const o = i * 3;
      const x = positions[o];
      const y = positions[o + 1];
      const z = positions[o + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
      if (z < this.minZ) this.minZ = z;
      if (z > this.maxZ) this.maxZ = z;
      const cx = Math.floor(x / this.cellSize);
      const cy = Math.floor(y / this.cellSize);
      const cz = Math.floor(z / this.cellSize);
      if (!this.hasCellOrigin) {
        this.cellOriginX = cx;
        this.cellOriginY = cy;
        this.cellOriginZ = cz;
        this.hasCellOrigin = true;
      }
      const key = this.packKey(cx, cy, cz);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(startId + i);
    }
    this.total += usable;
  }

  /** World-space bounds of every indexed point, or null when empty. */
  getBounds(): { min: Vec3; max: Vec3 } | null {
    if (this.total === 0 || !Number.isFinite(this.minX)) return null;
    return {
      min: { x: this.minX, y: this.minY, z: this.minZ },
      max: { x: this.maxX, y: this.maxY, z: this.maxZ },
    };
  }

  /** Resolve a global point id to its owning chunk, or null. */
  private chunkFor(globalId: number): IndexedChunk | null {
    // Chunks are appended in id order, so `startId` is sorted ascending —
    // binary search for the owning chunk (dense buckets can resolve
    // thousands of ids per query; a linear chunk scan would multiply
    // that by the chunk count, ~150 for a 30M-point stream).
    const chunks = this.chunks;
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunks[mid].startId <= globalId) lo = mid;
      else hi = mid - 1;
    }
    const c = chunks[lo];
    if (c && globalId >= c.startId && globalId < c.startId + c.count) return c;
    // Unreachable: every id in `cells` was handed out by this instance.
    return null;
  }

  private testPoint(
    p: Vec3,
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
    toleranceAt: (t: number) => number,
  ): PointCloudRayHit | null {
    const vx = p.x - origin.x;
    const vy = p.y - origin.y;
    const vz = p.z - origin.z;
    // t = distance along the ray to the closest approach point (dir is
    // assumed unit length — true for every ray this module receives,
    // see raycast-engine.ts / camera-projection.ts unprojectToRay).
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t < 0 || t > maxDistance) return null; // behind camera, or past the caller's bound
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const dx = p.x - px;
    const dy = p.y - py;
    const dz = p.z - pz;
    const perp = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (perp > toleranceAt(t)) return null;
    return { position: p, distance: t };
  }

  /**
   * Test every point in the `(2*radiusCells+1)^3` cell block around
   * (cx,cy,cz), skipping cells already visited by an earlier step of
   * the same query. `radiusCells` must cover `toleranceAt(t)` at the
   * depth this cell is visited at — see `queryRay`'s per-step radius
   * computation (#1860 review finding 1: a fixed +-1 dilation under-covers
   * tolerance at long range).
   */
  private testCellNeighborhood(
    cx: number,
    cy: number,
    cz: number,
    radiusCells: number,
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
    toleranceAt: (t: number) => number,
    classMask: Uint32Array | null | undefined,
    visited: Set<number>,
    best: { hit: PointCloudRayHit | null },
  ): void {
    const r = radiusCells;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const key = this.packKey(cx + dx, cy + dy, cz + dz);
          if (visited.has(key)) continue;
          visited.add(key);
          const bucket = this.cells.get(key);
          if (!bucket) continue;
          for (const globalId of bucket) {
            const chunk = this.chunkFor(globalId);
            if (!chunk) continue;
            const local = globalId - chunk.startId;
            // Skip points the splat shader currently hides via the LAS
            // class visibility mask (#1783) — the measure tool must not
            // snap to invisible scan data. Classification-free chunks
            // are class 0, mirroring the GPU vertex packing.
            const classId = chunk.classifications ? chunk.classifications[local] : 0;
            if (!classVisible(classMask, classId)) continue;
            const o = local * 3;
            const p = { x: chunk.positions[o], y: chunk.positions[o + 1], z: chunk.positions[o + 2] };
            const hit = this.testPoint(p, origin, dir, maxDistance, toleranceAt);
            if (hit && (!best.hit || hit.distance < best.hit.distance)) best.hit = hit;
          }
        }
      }
    }
  }

  /**
   * Nearest indexed point to `ray` (origin + unit `dir`) within
   * `toleranceAt(t)` world units of the ray axis at depth `t`,
   * restricted to `[0, maxDistance]`. Returns the candidate with the
   * SMALLEST `t` (nearest along the ray) among everything within
   * tolerance — not necessarily the one closest to the ray's infinite
   * line — matching how a real surface point would occlude anything
   * behind it.
   *
   * O(cells touched) via an Amanatides & Woo DDA march from the ray's
   * entry into the index's bounding box. `toleranceAt(t)` grows with
   * depth, so each visited cell's neighborhood dilation radius is
   * recomputed from `toleranceAt` at that cell's ray parameter —
   * `clamp(ceil(toleranceAt(t)/cellSize), 1, MAX_DILATION_RADIUS_CELLS)`
   * — instead of a fixed +-1 cell, so a point within the true
   * screen-space tolerance is never missed just because it's more than
   * half a cell off the ray's exact cell path at long range (#1860
   * review finding 1). Marching stops one cell past the first
   * tolerance hit (using the largest radius seen so far, conservative),
   * since DDA visits cells in non-decreasing ray-parameter order.
   */
  queryRay(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
    toleranceAt: (t: number) => number,
    /** Normalized 8-word LAS class visibility bitmask (#1783); points of
     *  hidden classes are skipped. Omit/null for "everything visible". */
    classMask?: Uint32Array | null,
  ): PointCloudRayHit | null {
    if (this.total === 0 || maxDistance <= 0) return null;
    const bounds = this.getBounds();
    if (!bounds) return null;

    const cs = this.cellSize;
    // Pad the coarse bounding-box cull by the MAX possible dilation
    // radius (not just one cell): `bounds` is the exact (often
    // near-zero-thickness, e.g. a flat wall scan) extent of the indexed
    // points, so an UNPADDED box/ray test would reject a ray that
    // passes close to — but not exactly through — the box, even though
    // a point within tolerance sits just past its face. Since the
    // per-cell dilation radius below can grow up to
    // `MAX_DILATION_RADIUS_CELLS` cells at long range, the outer cull
    // must be padded by the same amount or a ray whose only near-miss
    // is right at the cloud's edge could be rejected before the march
    // even starts.
    const maxPad = MAX_DILATION_RADIUS_CELLS * cs;
    const paddedBounds = {
      min: { x: bounds.min.x - maxPad, y: bounds.min.y - maxPad, z: bounds.min.z - maxPad },
      max: { x: bounds.max.x + maxPad, y: bounds.max.y + maxPad, z: bounds.max.z + maxPad },
    };

    const entry = rayBoxEntryExit(origin, dir, paddedBounds);
    if (!entry) return null;
    const tMin = Math.max(0, entry.tMin);
    const tMax = Math.min(maxDistance, entry.tMax);
    if (tMax < tMin) return null;

    const startX = origin.x + dir.x * tMin;
    const startY = origin.y + dir.y * tMin;
    const startZ = origin.z + dir.z * tMin;

    let cx = Math.floor(startX / cs);
    let cy = Math.floor(startY / cs);
    let cz = Math.floor(startZ / cs);

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

    const axisTMax = (o: number, d: number, cell: number): number => {
      if (d === 0) return Infinity;
      const boundary = d > 0 ? (cell + 1) * cs : cell * cs;
      return (boundary - o) / d;
    };
    const axisTDelta = (d: number): number => (d === 0 ? Infinity : Math.abs(cs / d));

    let tMaxX = axisTMax(origin.x, dir.x, cx);
    let tMaxY = axisTMax(origin.y, dir.y, cy);
    let tMaxZ = axisTMax(origin.z, dir.z, cz);
    const tDeltaX = axisTDelta(dir.x);
    const tDeltaY = axisTDelta(dir.y);
    const tDeltaZ = axisTDelta(dir.z);

    const best: { hit: PointCloudRayHit | null } = { hit: null };
    const visited = new Set<number>();
    let t = tMin;
    // Largest dilation radius (in cells) used by any step so far — the
    // early-break margin below must use this, not a fixed 1, since a
    // hit found under a wide (long-range) radius could still have a
    // nearer neighbor one radius-worth of cells further along the ray.
    let maxRadiusUsed = 1;

    // Safety cap: bounds the loop even if DDA step math misbehaves at a
    // grazing angle (near-zero direction components with fp error).
    const maxSteps = 8 + Math.ceil((tMax - tMin) / cs) * 3;
    for (let step = 0; step < maxSteps && t <= tMax; step++) {
      // Dilation radius covering toleranceAt(t) at THIS cell's ray
      // parameter — toleranceAt grows with depth, so a fixed +-1 cell
      // (as before #1860 finding 1) silently under-covers tolerance
      // once toleranceAt(t) exceeds one cell size.
      const tolWorld = toleranceAt(Math.max(0, t));
      const radius = Math.min(
        MAX_DILATION_RADIUS_CELLS,
        Math.max(1, Math.ceil(tolWorld / cs)),
      );
      if (radius > maxRadiusUsed) maxRadiusUsed = radius;

      this.testCellNeighborhood(cx, cy, cz, radius, origin, dir, tMax, toleranceAt, classMask, visited, best);

      // DDA visits cells in non-decreasing t order, so once we have a
      // hit and have advanced `maxRadiusUsed` full cells past it, no
      // later cell can hold a nearer point — stop early instead of
      // walking to tMax. Using the largest radius seen so far (rather
      // than the current step's) is conservative: a hit found under a
      // wide dilation could still have a nearer point just beyond a
      // narrower later step's smaller neighborhood.
      if (best.hit && t > best.hit.distance + maxRadiusUsed * cs) break;

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          cx += stepX;
          tMaxX += tDeltaX;
        } else {
          t = tMaxZ;
          cz += stepZ;
          tMaxZ += tDeltaZ;
        }
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        cy += stepY;
        tMaxY += tDeltaY;
      } else {
        t = tMaxZ;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }
    return best.hit;
  }

  /** Drop every retained position array and grid bucket. Call when the
   *  owning PointCloudNode is destroyed so nothing outlives its GPU
   *  resources (see `destroyNode` in point-cloud-node.ts). */
  dispose(): void {
    this.cells.clear();
    this.chunks = [];
    this.total = 0;
    this.minX = this.minY = this.minZ = Infinity;
    this.maxX = this.maxY = this.maxZ = -Infinity;
    this.cellOriginX = this.cellOriginY = this.cellOriginZ = 0;
    this.hasCellOrigin = false;
  }
}
