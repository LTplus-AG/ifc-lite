/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LOD1 index simplification (issue #1682, phase 5).
 *
 * Vertex-clustering decimation in the style of meshoptimizer's "sloppy"
 * simplifier, over the batch's EXISTING interleaved vertex buffer: vertices
 * are snapped to a uniform grid, each occupied cell elects its first vertex
 * as representative, and a triangle survives only when its three corners
 * land in three DISTINCT cells. The output is just another index buffer over
 * the same vertices — LOD costs index bytes only, no second vertex buffer,
 * and the per-vertex entityId lane (picking id + colour salt) rides along
 * with the representative vertex.
 *
 * Works on ifc-lite's unwelded flat-shaded soup because clustering keys on
 * POSITION, not index topology: coincident duplicated vertices land in the
 * same cell and collapse together. Representative normals are "whichever
 * face got there first" — visually fine at the sub-`thresholdPx` projected
 * sizes LOD1 is drawn at, and the no-weld invariant (#846) is untouched
 * because the full-detail LOD0 geometry is never modified.
 */

/** Below this many source triangles a batch keeps LOD0 only. */
export const LOD_MIN_TRIANGLES = 500;

/** Grid cell edge as a fraction of the batch AABB diagonal (error budget). */
export const LOD_CELL_FRACTION = 0.02;

/**
 * Cluster-simplify `indices` over interleaved vertex data.
 *
 * @param vertexData interleaved records, `strideFloats` floats per vertex,
 *   position at float offset 0..2 (the batch layout: 7 floats = 28 bytes)
 * @param cellSize world-space grid edge; non-positive returns null
 * @returns the LOD1 index buffer, or null when simplification does not pay
 *   (too few source triangles, or the result is not meaningfully smaller)
 */
/**
 * V8 caps a `Map` at 2^24 - 1 entries and throws `RangeError: Map maximum size
 * exceeded` on the next insert. Stopping one short keeps the refusal ours.
 */
const MAX_MAP_ENTRIES = 2 ** 24 - 1;

export function simplifyIndicesByClustering(
  vertexData: Float32Array,
  strideFloats: number,
  indices: Uint32Array,
  cellSize: number,
): Uint32Array | null {
  const triangleCount = (indices.length / 3) | 0;
  if (triangleCount < LOD_MIN_TRIANGLES) return null;
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) return null;

  // Cell id per referenced vertex, memoized (vertices are referenced ~1-3x).
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
  // -1 means "not yet memoized". Vertex indices are non-negative, so the
  // sentinel cannot collide with a real representative. Int32Array also costs
  // 4 bytes per vertex flat, well under the Map's per-entry overhead for the
  // same population.
  const vertexCount = strideFloats > 0 ? (vertexData.length / strideFloats) | 0 : 0;
  const cellOf = new Int32Array(vertexCount).fill(-1); // vertexIndex -> representative, -1 = unset
  const repOfCell = new Map<string, number>(); // cell key -> representative vertexIndex

  // Clustering is ENTITY-SCOPED: the per-vertex entityId lane (u32 bit-cast
  // at float offset 6 in the batch layout) joins the cell key, so co-located
  // vertices from DIFFERENT entities (a wall face touching a slab face)
  // never share a representative. Without this a LOD triangle could inherit
  // a neighbour entity's id lane — wrong object-id target output (separation
  // lines) and wrong overlay depth-salt at LOD distance. Costs a little
  // reduction ratio; correctness first.
  const idLane = strideFloats > 6
    ? new Uint32Array(vertexData.buffer, vertexData.byteOffset, vertexData.length)
    : null;

  const repOf = (vi: number): number => {
    const memo = cellOf[vi];
    if (memo !== -1) return memo;
    const base = vi * strideFloats;
    const cx = Math.floor(vertexData[base] / cellSize);
    const cy = Math.floor(vertexData[base + 1] / cellSize);
    const cz = Math.floor(vertexData[base + 2] / cellSize);
    const entity = idLane ? idLane[base + 6] : 0;
    const key = `${cx},${cy},${cz},${entity}`;
    const existing = repOfCell.get(key);
    let rep: number;
    if (existing === undefined) {
      rep = vi;
      // `repOfCell` is the remaining Map, and it is bounded by the number of
      // OCCUPIED cells rather than by vertices, so it only approaches the same
      // 2^24 cap when almost nothing collapses. That case is precisely the one
      // where LOD1 would be no smaller than LOD0, so bail through the
      // function's existing "simplification does not pay" contract rather than
      // letting it throw. Callers already handle null (`scene.ts` renders
      // LOD0), so nothing goes missing (issue #3028).
      if (repOfCell.size >= MAX_MAP_ENTRIES) return -1;
      repOfCell.set(key, vi);
    } else {
      rep = existing;
    }
    cellOf[vi] = rep;
    return rep;
  };

  const out = new Uint32Array(indices.length);
  let w = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = repOf(indices[i]);
    const b = repOf(indices[i + 1]);
    const c = repOf(indices[i + 2]);
    // A cell-map overflow (see `repOf`) means nothing was collapsing anyway.
    if (a < 0 || b < 0 || c < 0) return null;
    // Collapsed triangles (any two corners in the same cell) are dropped.
    if (a === b || b === c || a === c) continue;
    out[w] = a;
    out[w + 1] = b;
    out[w + 2] = c;
    w += 3;
  }

  // Not worth a second index buffer unless it drops a decent fraction.
  if (w >= indices.length * 0.75) return null;
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
