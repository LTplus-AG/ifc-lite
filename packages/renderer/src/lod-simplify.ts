/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LOD1 index simplification (issue #1682, phase 5).
 *
 * Vertex-clustering decimation in the style of meshoptimizer's "sloppy"
 * simplifier, over the batch's EXISTING interleaved vertex buffer: vertices
 * are snapped to a uniform grid, each occupied cell elects a representative,
 * and a triangle survives only when its three corners land in three DISTINCT
 * cells. The output is just another index buffer over the same vertices —
 * LOD costs index bytes only, no second vertex buffer, and the per-vertex
 * entityId lane (picking id + colour salt) rides along with the
 * representative vertex.
 *
 * Works on ifc-lite's unwelded flat-shaded soup because clustering keys on
 * POSITION, not index topology: coincident duplicated vertices land in the
 * same cell and collapse together. The no-weld invariant (#846) is untouched
 * because the full-detail LOD0 geometry is never modified.
 *
 * The result depends only on what the batch holds, never on how it got there:
 * a batch's pieces arrive in worker-completion order, and its vertex frame's
 * origin is set by whichever batch is created first. So the grid is anchored
 * at the world origin (`frameOrigin`) and each cell elects its canonical
 * vertex (smallest position, then normal), not the first one referenced.
 * Exact up to the f32 rounding of frame-relative positions: when two loads
 * pick different frame origins, a vertex within rounding of a cell edge can
 * still land in the neighbouring cell (2 batches of 2439 on a 100k campus).
 */

/** Below this many source triangles a batch keeps LOD0 only. */
export const LOD_MIN_TRIANGLES = 500;

/** A LOD1 range keeping this share of its source indices or more does not pay for its buffer. */
export const LOD_MAX_KEPT_FRACTION = 0.75;

/** Grid cell edge as a fraction of the batch AABB diagonal (error budget). */
export const LOD_CELL_FRACTION = 0.02;

/** Where the fields sit in each record, and which frame its positions are in. */
export interface LodClusterLayout {
  /** Float offset of the u32 entity lane: 6 in the batch layout. Records shorter than this carry none. */
  idLaneOffset?: number;
  /** Float offset of the normal, which breaks ties between coincident vertices: 3 (the batch layout) when records hold 7+ floats. */
  normalOffset?: number;
  /** World position of the records' frame origin; cells are anchored at the world origin. */
  frameOrigin?: readonly [number, number, number];
  /**
   * Return the clustered indices whatever their size (possibly empty): no minimum triangle count and
   * no "does not pay" test. For a caller that clusters a set of index runs and judges them together
   * (compact pages, `compact-lod.ts`); a cell-map overflow still returns null.
   */
  unconditional?: boolean;
}

/**
 * V8 caps a `Map` at 2^24 - 1 entries and throws `RangeError: Map maximum size
 * exceeded` on the next insert. Stopping one short keeps the refusal ours.
 */
const MAX_MAP_ENTRIES = 2 ** 24 - 1;

/**
 * Cluster-simplify `indices` over interleaved vertex data.
 *
 * @param vertexData interleaved records, `strideFloats` floats per vertex,
 *   position at float offset 0..2 (the batch layout: 7 floats = 28 bytes)
 * @param cellSize world-space grid edge; non-positive returns null
 * @returns the LOD1 index buffer, or null when simplification does not pay
 *   (too few source triangles, or the result is not meaningfully smaller)
 */
export function simplifyIndicesByClustering(
  vertexData: Float32Array,
  strideFloats: number,
  indices: Uint32Array,
  cellSize: number,
  /** The record layout; a number is the entity-lane offset alone (the older signature). */
  layout: LodClusterLayout | number = {},
): Uint32Array | null {
  // The older numeric form named the lane only: it gets no normal tie-break, as before.
  const { idLaneOffset = 6, frameOrigin = [0, 0, 0], unconditional = false }: LodClusterLayout = typeof layout === 'number' ? { idLaneOffset: layout } : layout;
  const normalOffset = typeof layout === 'number' ? undefined : layout.normalOffset ?? (strideFloats >= 7 ? 3 : undefined);
  const triangleCount = (indices.length / 3) | 0;
  if (triangleCount < LOD_MIN_TRIANGLES && !unconditional) return null;
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) return null;

  // Cell per referenced vertex, memoized (vertices are referenced ~1-3x).
  //
  // A TYPED ARRAY, not a Map, because V8 caps a Map at 2^24 - 1 entries and
  // this is keyed per vertex. A single batch can exceed that: bucket size is
  // bounded in BYTES against the GPU's `maxBufferSize` (`scene.ts`
  // `resolveActiveBucket`), and that limit is deliberately requested at the
  // adapter maximum so multi-GB models render, which on a 2 GiB adapter allows
  // roughly 69M vertices per bucket at 28 B each. Buckets also group by
  // spatial cell and colour rather than by model, so a dense federated load
  // co-batches. Production hit exactly this: `RangeError: Map maximum size
  // exceeded` from this line (issue #3028), which rejected the whole finalize
  // and left the viewer on streaming fragments.
  //
  // -1 means "not yet memoized". Cell numbers are non-negative, so the
  // sentinel cannot collide. Int32Array also costs 4 bytes per vertex flat,
  // well under the Map's per-entry overhead for the same population.
  const vertexCount = strideFloats > 0 ? (vertexData.length / strideFloats) | 0 : 0;
  const cellOf = new Int32Array(vertexCount).fill(-1); // vertexIndex -> cell number, -1 = unset
  const cellOfKey = new Map<number | string, number>(); // exact cell key -> cell number
  // Cell number -> elected vertexIndex, grown with the occupied cells (at most vertexCount).
  let representative = new Int32Array(Math.max(1, Math.min(vertexCount, 1024)));
  let cells = 0;
  let cellOrigin: readonly [number, number, number] | undefined;
  const [ox, oy, oz] = frameOrigin;

  // Clustering is ENTITY-SCOPED: the per-vertex entityId lane (u32 bit-cast
  // at float offset 6 in the batch layout) joins the cell key, so co-located
  // vertices from DIFFERENT entities (a wall face touching a slab face)
  // never share a representative. Without this a LOD triangle could inherit
  // a neighbour entity's id lane — wrong object-id target output (separation
  // lines) and wrong overlay depth-salt at LOD distance. Costs a little
  // reduction ratio; correctness first.
  const idLane = strideFloats > idLaneOffset
    ? new Uint32Array(vertexData.buffer, vertexData.byteOffset, vertexData.length)
    : null;
  // Fields compared to elect a representative: position, then the normal when the records carry one.
  const ranked = normalOffset !== undefined && strideFloats >= normalOffset + 3
    ? [0, 1, 2, normalOffset, normalOffset + 1, normalOffset + 2] : [0, 1, 2];

  /** Whether vertex `a` outranks `b` as its cell's representative: ranked fields, then index. */
  const precedes = (a: number, b: number): boolean => {
    const ba = a * strideFloats;
    const bb = b * strideFloats;
    for (const k of ranked) {
      const x = vertexData[ba + k], y = vertexData[bb + k];
      const xNaN = Number.isNaN(x), yNaN = Number.isNaN(y);
      if (x === y || (xNaN && yNaN)) continue;
      // NaN ranks last, so the order stays total and the election order-independent.
      if (xNaN || yNaN) return yNaN;
      return x < y;
    }
    return a < b;
  };

  const cellNumber = (vi: number): number => {
    const memo = cellOf[vi];
    if (memo !== -1) return memo;
    const base = vi * strideFloats;
    const cx = Math.floor((vertexData[base] + ox) / cellSize);
    const cy = Math.floor((vertexData[base + 1] + oy) / cellSize);
    const cz = Math.floor((vertexData[base + 2] + oz) / cellSize);
    const entity = idLane ? idLane[base + idLaneOffset] : 0;
    // #3991: normal LOD cells fit in a small neighborhood. Pack that exact
    // neighborhood with the FULL u32 entity lane instead of allocating a key
    // string per vertex. Keep generic tiny-cell/huge/nonfinite inputs exact.
    let key: number | string;
    if (Number.isSafeInteger(cx) && Number.isSafeInteger(cy) && Number.isSafeInteger(cz)) {
      cellOrigin ??= [cx, cy, cz];
      const dx = cx - cellOrigin[0];
      const dy = cy - cellOrigin[1];
      const dz = cz - cellOrigin[2];
      if (dx >= -64 && dx < 64 && dy >= -64 && dy < 64 && dz >= -64 && dz < 64) {
        // Safe integer coordinates and anchor make these bounded differences
        // exact. 3 * 7 cell bits + 32 entity bits fit in 53 bits: the largest
        // possible key is 2^53 - 1, with no rounding or dropped entity bits.
        key = entity * 0x200000 + (dx + 64) * 0x4000 + (dy + 64) * 0x80 + dz + 64;
      } else {
        key = `${cx},${cy},${cz},${entity}`;
      }
    } else {
      key = `${cx},${cy},${cz},${entity}`;
    }
    let cell = cellOfKey.get(key);
    if (cell === undefined) {
      // `cellOfKey` is the remaining Map, and it is bounded by the number of
      // OCCUPIED cells rather than by vertices, so it only approaches the same
      // 2^24 cap when almost nothing collapses. That case is precisely the one
      // where LOD1 would be no smaller than LOD0, so bail through the
      // function's existing "simplification does not pay" contract rather than
      // letting it throw. Callers already handle null (`scene.ts` renders
      // LOD0), so nothing goes missing (issue #3028).
      if (cellOfKey.size >= MAX_MAP_ENTRIES) return -1;
      cell = cells++;
      if (cell === representative.length) {
        const grown = new Int32Array(Math.max(cell + 1, Math.min(vertexCount, representative.length * 2)));
        grown.set(representative);
        representative = grown;
      }
      cellOfKey.set(key, cell);
      representative[cell] = vi;
    } else if (precedes(vi, representative[cell])) {
      representative[cell] = vi;
    }
    cellOf[vi] = cell;
    return cell;
  };

  // Every corner's cell first, so each cell has elected its representative
  // before any triangle reads it.
  for (let i = 0; i < triangleCount * 3; i++) {
    // A cell-map overflow (see `cellNumber`) means nothing was collapsing anyway.
    if (cellNumber(indices[i]) < 0) return null;
  }

  const out = new Uint32Array(triangleCount * 3);
  let w = 0;
  for (let i = 0; i < triangleCount * 3; i += 3) {
    const a = cellOf[indices[i]];
    const b = cellOf[indices[i + 1]];
    const c = cellOf[indices[i + 2]];
    // Collapsed triangles (any two corners in the same cell) are dropped.
    if (a === b || b === c || a === c) continue;
    out[w] = representative[a];
    out[w + 1] = representative[b];
    out[w + 2] = representative[c];
    w += 3;
  }

  if (unconditional) return out.slice(0, w);
  // Not worth a second index buffer unless it drops a decent fraction.
  if (w >= indices.length * LOD_MAX_KEPT_FRACTION) return null;
  if (w === 0) return null;
  return out.slice(0, w);
}

/** Cell size for a batch from its world AABB (diagonal * LOD_CELL_FRACTION). */
export function lodCellSizeForBounds(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * LOD_CELL_FRACTION;
}
