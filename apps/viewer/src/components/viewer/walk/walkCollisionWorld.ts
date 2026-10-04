/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The walk capsule's view of the model: which triangles are near a box.
 *
 * Built for the largest models the viewer opens, where an up-front triangle
 * index is not an option (tens of millions of triangles would cost seconds and
 * gigabytes, for a walker that only ever touches the few metres around it):
 *
 * - **Entity level, built once.** One tree over every entity's cached world
 *   AABB. No vertex is read to build it.
 * - **Triangle level, built lazily.** An entity's triangles are indexed the
 *   first time the walker comes near it. The index references the scene's own
 *   position/index arrays (no copy) in their local frame, so a large mesh costs
 *   its tree and nothing else. Small meshes skip the tree and are scanned.
 * - **Bounded.** Prepared entities are evicted least-recently-touched once their
 *   triangle total passes a cap, and {@link prefetch} prepares the ring around
 *   the walker under a time budget so first contact never stalls a frame.
 *
 * World is the viewer's Y-up metres; a piece's world position is
 * `origin + position`, the same convention the picking raycaster uses.
 */

import { buildAabbTree, IndexList, queryAabbTree, rayQueryAabbTree, type AabbTree } from './aabbTree.js';
import { gatherPiece, preparePiece, raycastPiece, type PreparedPiece, type TriangleList } from './walkTriangles.js';

export interface WalkPiece {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly origin?: ArrayLike<number>;
  readonly ifcType?: string;
}

export interface WalkBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** What the collision world needs from a scene. Kept narrow so tests and the offline benchmark can supply a model without a GPU. */
export interface WalkGeometrySource {
  entityIds(): Iterable<number>;
  bounds(id: number): WalkBounds | null;
  /** The entity's resident mesh pieces, or undefined when none are on the CPU. */
  pieces(id: number): readonly WalkPiece[] | undefined;
}

/**
 * IFC classes the walker passes through. Spaces are volumes that would trap
 * the capsule; openings and virtual elements are not physical; doors stay
 * walkable however their leaf was modelled (RvtGo makes the same call).
 */
const PASS_THROUGH_TYPES = new Set([
  'ifcspace', 'ifcopeningelement', 'ifcopeningstandardcase', 'ifcvoidingfeature',
  'ifcdoor', 'ifcdoorstandardcase', 'ifcvirtualelement', 'ifcannotation', 'ifcgrid',
  'ifcspatialzone', 'ifcexternalspatialelement', 'ifcalignment', 'ifcreferent',
]);

export function isPassThroughType(ifcType: string | undefined): boolean {
  return ifcType !== undefined && PASS_THROUGH_TYPES.has(ifcType.toLowerCase());
}

/** Default cap on prepared triangles kept across all entities. */
const DEFAULT_TRIANGLE_BUDGET = 4_000_000;

interface PreparedEntity {
  readonly pieces: readonly PreparedPiece[];
  readonly triangles: number;
  lastUsed: number;
}

export interface WalkWorldStats {
  entities: number;
  buildMs: number;
  prepared: number;
  preparedTriangles: number;
  preparedMs: number;
  evicted: number;
  /** Entities near the walker whose geometry was not on the CPU. */
  missing: number;
}

export interface WalkCollisionWorldOptions {
  /** Live filter (hidden / isolated): consulted on every query, so it can change mid-walk. */
  collidable?: (id: number) => boolean;
  triangleBudget?: number;
  now?: () => number;
}

export interface WalkRayHit {
  t: number;
  /** Unit face normal, flipped to face the ray origin. */
  nx: number; ny: number; nz: number;
  entityId: number;
}

export class WalkCollisionWorld {
  private readonly ids: Uint32Array;
  /** Entity boxes, 6 floats each, kept so a raycast can visit entities nearest-first. */
  private readonly boxes: Float32Array;
  private readonly entityTree: AabbTree;
  private readonly prepared = new Map<number, PreparedEntity | null>();
  private preparedTriangles = 0;
  private tick = 0;
  private readonly candidates = new IndexList(512);
  private readonly local = new IndexList(1024);
  private readonly collidable: (id: number) => boolean;
  private readonly triangleBudget: number;
  private readonly now: () => number;
  readonly stats: WalkWorldStats;
  /** World AABB of everything indexed (for the ground plane and spawn). */
  readonly bounds: WalkBounds | null;

  constructor(private readonly source: WalkGeometrySource, options: WalkCollisionWorldOptions = {}) {
    this.collidable = options.collidable ?? (() => true);
    this.triangleBudget = options.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET;
    this.now = options.now ?? (() => performance.now());
    const start = this.now();

    const idList: number[] = [];
    let boxes = new Float32Array(6 * 1024);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const id of source.entityIds()) {
      const b = source.bounds(id);
      if (!b || !(b.min.x <= b.max.x && b.min.y <= b.max.y && b.min.z <= b.max.z)) continue;
      const o = idList.length * 6;
      if (o + 6 > boxes.length) {
        const grown = new Float32Array(boxes.length * 2);
        grown.set(boxes);
        boxes = grown;
      }
      // Widen by one float32 ulp-ish margin so rounding never shrinks a box.
      boxes[o] = b.min.x - 1e-3; boxes[o + 1] = b.min.y - 1e-3; boxes[o + 2] = b.min.z - 1e-3;
      boxes[o + 3] = b.max.x + 1e-3; boxes[o + 4] = b.max.y + 1e-3; boxes[o + 5] = b.max.z + 1e-3;
      idList.push(id);
      if (b.min.x < minX) minX = b.min.x; if (b.min.y < minY) minY = b.min.y; if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.x > maxX) maxX = b.max.x; if (b.max.y > maxY) maxY = b.max.y; if (b.max.z > maxZ) maxZ = b.max.z;
    }
    this.ids = Uint32Array.from(idList);
    this.boxes = boxes;
    this.entityTree = buildAabbTree(boxes, idList.length);
    this.bounds = idList.length > 0
      ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
      : null;
    this.stats = {
      entities: idList.length, buildMs: this.now() - start,
      prepared: 0, preparedTriangles: 0, preparedMs: 0, evicted: 0, missing: 0,
    };
  }

  /** Advance the LRU clock; call once per physics tick. */
  beginTick(): void {
    this.tick++;
  }

  /**
   * Gather every triangle of a collidable entity whose box overlaps the query
   * box into `out` (world coordinates). Prepares entities on first contact.
   */
  gather(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: TriangleList): void {
    const candidates = this.candidates;
    candidates.clear();
    queryAabbTree(this.entityTree, minX, minY, minZ, maxX, maxY, maxZ, candidates);
    for (let c = 0; c < candidates.length; c++) {
      const id = this.ids[candidates.items[c]];
      if (!this.collidable(id)) continue;
      const entity = this.prepare(id);
      if (!entity) continue;
      entity.lastUsed = this.tick;
      for (const piece of entity.pieces) gatherPiece(piece, minX, minY, minZ, maxX, maxY, maxZ, out, this.local);
    }
    this.enforceBudget();
  }

  /** Nearest hit along `origin + t * dir`, t in [0, tMax]. `dir` must be unit length for `t` to be a distance. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): WalkRayHit | null {
    const candidates = this.candidates;
    candidates.clear();
    rayQueryAabbTree(this.entityTree, ox, oy, oz, dx, dy, dz, tMax, candidates);
    // Nearest box entry first, and stop once boxes start beyond the best hit:
    // a long view ray must not index every entity it passes over.
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const order: Array<[number, number]> = [];
    for (let c = 0; c < candidates.length; c++) {
      const item = candidates.items[c];
      const o = item * 6, b = this.boxes;
      const entry = slabEntry(ox, oy, oz, ix, iy, iz, b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]);
      if (entry <= tMax) order.push([entry, item]);
    }
    order.sort((p, q) => p[0] - q[0]);
    let best: WalkRayHit | null = null;
    let bestT = tMax;
    for (const [entry, item] of order) {
      if (entry > bestT) break;
      const id = this.ids[item];
      if (!this.collidable(id)) continue;
      const entity = this.prepare(id);
      if (!entity) continue;
      entity.lastUsed = this.tick;
      for (const piece of entity.pieces) {
        const hit = raycastPiece(piece, ox, oy, oz, dx, dy, dz, bestT, this.local);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          best = { ...hit, entityId: id };
        }
      }
    }
    this.enforceBudget();
    return best;
  }

  /**
   * Prepare not-yet-indexed entities overlapping the box, in tree order, until
   * `budgetMs` is spent. Returns how many remain unprepared.
   */
  prefetch(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, budgetMs: number): number {
    const candidates = this.candidates;
    candidates.clear();
    queryAabbTree(this.entityTree, minX, minY, minZ, maxX, maxY, maxZ, candidates);
    const start = this.now();
    let remaining = 0;
    for (let c = 0; c < candidates.length; c++) {
      const id = this.ids[candidates.items[c]];
      if (this.prepared.has(id) || !this.collidable(id)) continue;
      if (this.now() - start >= budgetMs) { remaining++; continue; }
      const entity = this.prepare(id);
      if (entity) entity.lastUsed = this.tick;
    }
    this.enforceBudget();
    return remaining;
  }

  private prepare(id: number): PreparedEntity | null {
    const cached = this.prepared.get(id);
    if (cached !== undefined) return cached;
    const pieces = this.source.pieces(id);
    if (!pieces || pieces.length === 0) {
      // Not resident (cold-evicted, or the scene released its CPU copy). Do
      // NOT cache the miss: the bucket may be restored a few frames later.
      this.stats.missing++;
      return null;
    }
    const start = this.now();
    const prepared: PreparedPiece[] = [];
    let triangles = 0;
    for (const piece of pieces) {
      if (isPassThroughType(piece.ifcType)) continue;
      const count = Math.floor(piece.indices.length / 3);
      if (count === 0) continue;
      prepared.push(preparePiece(piece, count));
      triangles += count;
    }
    const entity = prepared.length > 0 ? { pieces: prepared, triangles, lastUsed: this.tick } : null;
    this.prepared.set(id, entity);
    this.preparedTriangles += triangles;
    this.stats.prepared++;
    this.stats.preparedTriangles = this.preparedTriangles;
    this.stats.preparedMs += this.now() - start;
    return entity;
  }

  private drop(id: number): void {
    const entity = this.prepared.get(id);
    if (entity) this.preparedTriangles -= entity.triangles;
    this.prepared.delete(id);
  }

  private enforceBudget(): void {
    if (this.preparedTriangles <= this.triangleBudget) return;
    // Evict entities not touched this tick, oldest first, down to 75% of the
    // budget so the sweep does not rerun on the very next query.
    const victims: Array<[number, number]> = [];
    for (const [id, entity] of this.prepared) {
      if (entity && entity.lastUsed < this.tick) victims.push([entity.lastUsed, id]);
    }
    victims.sort((a, b) => a[0] - b[0]);
    const target = this.triangleBudget * 0.75;
    for (const [, id] of victims) {
      if (this.preparedTriangles <= target) break;
      this.drop(id);
      this.stats.evicted++;
    }
    this.stats.preparedTriangles = this.preparedTriangles;
  }

}

/** Where a ray enters a box (0 if it starts inside), or Infinity if it misses. Reciprocal direction in. */
function slabEntry(
  ox: number, oy: number, oz: number, ix: number, iy: number, iz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): number {
  let t0 = (x0 - ox) * ix, t1 = (x1 - ox) * ix;
  let near = Math.min(t0, t1), far = Math.max(t0, t1);
  t0 = (y0 - oy) * iy; t1 = (y1 - oy) * iy;
  near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
  t0 = (z0 - oz) * iz; t1 = (z1 - oz) * iz;
  near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
  // NaN (an axis-parallel ray on a box face): keep the box, at distance 0.
  if (Number.isNaN(near) || Number.isNaN(far)) return 0;
  return far >= Math.max(near, 0) ? Math.max(near, 0) : Infinity;
}
