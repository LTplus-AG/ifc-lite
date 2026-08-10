/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Even-odd triangulation of a flat ring set (issue #2516).
 *
 * Two consumers hand us the same shape of input — a bag of closed 2D rings in
 * the (x, z) plane with no promised winding and no promised order:
 *
 *   - section cut caps (`buildCapFillGeometry`), where the rings are a cut
 *     polygon's outer boundary plus the openings/voids the plane sliced
 *     through;
 *   - `IfcAnnotationFillArea` (`SymbolicFillPipeline`), where the rings are the
 *     annotation's outer bound plus its inner bounds.
 *
 * Both used to assume "ring 0 is the outer boundary, everything else is a hole"
 * and then bridge the holes in and ear-clip. That produced a *near-empty* cap
 * wherever a profile had a hole: the bridge duplicates two vertices, and the
 * old ear test treated any vertex lying ON a candidate ear (including those
 * duplicates) as obstructing it, so almost no ear was ever clipped. A 4x4
 * square with a 2x2 hole came out at area 2 instead of 12.
 *
 * The fix here is deliberately NOT "reverse the hole's winding" — with the
 * hole merely added rather than subtracted the same case comes out at 20. What
 * is actually needed is the even-odd rule:
 *
 *   1. Nest the rings: a ring's depth is the number of other rings that
 *      contain it. Even depth = filled boundary, odd depth = hole. That is what
 *      makes a hole-inside-a-hole (an island) come back as solid rather than as
 *      another void.
 *   2. Group each even-depth ring with its immediate children.
 *   3. Bridge each group's holes into its boundary and ear-clip, with an ear
 *      test that (a) only lets REFLEX vertices obstruct an ear and (b) ignores
 *      vertices coincident with the ear's own corners, which is exactly the
 *      bridge duplicate that used to deadlock the clipper.
 *
 * Everything is O(n²) in the ring's vertex count, which is fine: fill regions
 * and cut cross-sections are tens of vertices, not thousands.
 */

// `fill-bridge-anchor.ts` imports only the `Pt` TYPE back from here, which is
// erased at compile time, so this pairing is not a runtime cycle.
import { chooseBridgeAnchor } from './fill-bridge-anchor.js';

/** A point on the fill plane. Y is constant per fill, so only (x, z) travel. */
export type Pt = { x: number; z: number };

/** Below this, a cross product is treated as zero (collinear/degenerate). */
const EPS_CROSS = 1e-12;
/** Coordinate tolerance for "these two vertices are the same point". */
const EPS_SAME = 1e-9;

/**
 * Shoelace area of a ring in the (x, z) plane. Positive = counter-clockwise.
 * Winding normalisation is built on this, and tests use it to state the
 * analytic area a ring set must triangulate to.
 */
export function signedRingArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/** Crossing-number point-in-polygon. Points exactly on the ring are undefined
 *  here — callers screen those out with {@link pointOnRing} first. */
function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when `p` lies on one of the ring's edges (within tolerance). */
function pointOnRing(p: Pt, ring: readonly Pt[]): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
    if (Math.abs(cross) > EPS_SAME) continue;
    const dot = (p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z);
    const len = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
    if (dot >= -EPS_SAME && dot <= len + EPS_SAME) return true;
  }
  return false;
}

/**
 * True when `inner` sits inside `outer`. Well-formed IFC bounds never cross,
 * so the first vertex of `inner` that is not ON `outer` settles it; shared
 * vertices and shared edge stretches (a hole flush against the boundary) are
 * skipped rather than decided.
 */
function ringInsideRing(inner: readonly Pt[], outer: readonly Pt[]): boolean {
  for (const p of inner) {
    if (pointOnRing(p, outer)) continue;
    return pointInRing(p, outer);
  }
  return false;
}

/** One filled boundary and the holes cut directly out of it. */
export interface RingGroup {
  outer: Pt[];
  holes: Pt[][];
}

/**
 * Sort a bag of rings into filled boundaries and their holes by the even-odd
 * rule. Rings with fewer than 3 vertices are dropped.
 *
 * A ring nested at odd depth is a hole; at even depth it is filled — so an
 * island inside a hole comes back as its own group rather than being counted
 * as void. A ring at depth d+1 that is contained in a ring at depth d is
 * necessarily its immediate child (every ring containing the child also
 * contains the parent, so the counts can only differ by the parent itself),
 * which is why no explicit tree is built.
 */
export function groupRingsByNesting(rings: readonly (readonly Pt[])[]): RingGroup[] {
  const usable = rings.filter((r) => r.length >= 3).map((r) => r.slice());
  const depth = usable.map((r, i) =>
    usable.reduce((d, other, j) => (j !== i && ringInsideRing(r, other) ? d + 1 : d), 0),
  );

  const groups: RingGroup[] = [];
  for (let i = 0; i < usable.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    const holes: Pt[][] = [];
    for (let j = 0; j < usable.length; j++) {
      if (j === i || depth[j] !== depth[i] + 1) continue;
      if (ringInsideRing(usable[j], usable[i])) holes.push(usable[j]);
    }
    groups.push({ outer: usable[i], holes });
  }
  return groups;
}

function asCcw(ring: Pt[]): Pt[] {
  return signedRingArea(ring) >= 0 ? ring : ring.slice().reverse();
}

function asCw(ring: Pt[]): Pt[] {
  return signedRingArea(ring) <= 0 ? ring : ring.slice().reverse();
}

/**
 * Stitch each hole into the outer ring with a single bridge edge so the result
 * is one simple polygon ear-clipping can handle. Mirrors mapbox/earcut's
 * `eliminateHoles` pass:
 *
 *   1. For each hole, pick its rightmost (max-x) vertex as the bridge start.
 *   2. Sort holes by descending bridge-start x so outer holes go in first.
 *   3. Pick the anchor on the boundary the bridge can actually reach without
 *      crossing anything — see `fill-bridge-anchor.ts`.
 *   4. Splice the hole in at that anchor, closing both ends back to their
 *      starts to form a zero-area bridge edge.
 *
 * Windings are normalised here rather than assumed: the boundary is made CCW
 * and every hole CW, so the merged ring's signed area stays consistent no
 * matter how the caller's rings were wound.
 */
export function joinHoles(outer: Pt[], holes: Pt[][]): Pt[] {
  if (holes.length === 0) return outer;

  type HoleEntry = { ring: Pt[]; startIdx: number; startX: number };
  const sorted: HoleEntry[] = holes
    .map((h) => asCw(h))
    .map((ring) => {
      let bestI = 0;
      for (let i = 1; i < ring.length; i++) {
        if (ring[i].x > ring[bestI].x) bestI = i;
      }
      return { ring, startIdx: bestI, startX: ring[bestI].x };
    })
    .sort((a, b) => b.startX - a.startX);

  let result: Pt[] = asCcw(outer).slice();

  for (const { ring, startIdx } of sorted) {
    const bestIdx = chooseBridgeAnchor(result, ring, startIdx);
    if (bestIdx < 0) continue;

    const rotated = [...ring.slice(startIdx), ...ring.slice(0, startIdx)];
    result = [
      ...result.slice(0, bestIdx + 1),
      ...rotated,
      rotated[0],
      result[bestIdx],
      ...result.slice(bestIdx + 1),
    ];
  }

  return result;
}

function samePoint(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= EPS_SAME && Math.abs(a.z - b.z) <= EPS_SAME;
}

function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const s1 = (p.x - c.x) * (a.z - c.z) - (a.x - c.x) * (p.z - c.z);
  const s2 = (p.x - a.x) * (b.z - a.z) - (b.x - a.x) * (p.z - a.z);
  const s3 = (p.x - b.x) * (c.z - b.z) - (c.x - b.x) * (p.z - b.z);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon (which may be a bridged
 * polygon-with-holes). Returns triangles as index triples into `ring`.
 *
 * Two properties keep the bridged case from deadlocking, and both are the
 * #2516 fix:
 *
 *   - only a REFLEX vertex can obstruct an ear of a simple polygon, so convex
 *     vertices are not tested at all. Testing them made every vertex lying on
 *     an axis-aligned ear edge veto that ear;
 *   - a vertex coincident with one of the ear's own corners is skipped. That
 *     is precisely the duplicate the bridge introduces; the slit it belongs to
 *     has zero width, so it cannot cover any of the ear.
 *
 * When no ear can be found the clipper drops one zero-area (collinear or
 * duplicated) vertex — which cannot change the covered region — and retries,
 * rather than bailing out with most of the polygon untriangulated.
 */
export function earClip(ring: ReadonlyArray<Pt>): number[][] {
  const n = ring.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  // Walk the ring counter-clockwise so the ear test below has a fixed sign.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area2 += a.x * b.z - b.x * a.z;
  }
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(area2 > 0 ? i : n - 1 - i);

  const triangles: number[][] = [];
  let safety = indices.length * indices.length;

  while (indices.length > 3 && safety-- > 0) {
    let found = false;
    for (let i = 0; i < indices.length; i++) {
      if (!isEar(ring, indices, i)) continue;
      const m = indices.length;
      triangles.push([indices[(i + m - 1) % m], indices[i], indices[(i + 1) % m]]);
      indices.splice(i, 1);
      found = true;
      break;
    }
    if (found) continue;

    const degenerate = findZeroAreaVertex(ring, indices);
    if (degenerate < 0) break; // genuinely stuck — emit what we have
    indices.splice(degenerate, 1);
  }

  if (indices.length === 3) {
    triangles.push([indices[0], indices[1], indices[2]]);
  }
  return triangles;
}

function isEar(ring: ReadonlyArray<Pt>, indices: readonly number[], i: number): boolean {
  const m = indices.length;
  const ia = indices[(i + m - 1) % m];
  const ib = indices[i];
  const ic = indices[(i + 1) % m];
  const a = ring[ia];
  const b = ring[ib];
  const c = ring[ic];

  const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
  if (cross <= EPS_CROSS) return false; // reflex or degenerate corner

  for (let j = 0; j < m; j++) {
    const ij = indices[j];
    if (ij === ia || ij === ib || ij === ic) continue;
    const p = ring[ij];
    if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) continue;

    const prev = ring[indices[(j + m - 1) % m]];
    const next = ring[indices[(j + 1) % m]];
    const pCross = (p.x - prev.x) * (next.z - p.z) - (p.z - prev.z) * (next.x - p.x);
    if (pCross > EPS_CROSS) continue; // strictly convex — cannot obstruct

    if (pointInTriangle(p, a, b, c)) return false;
  }
  return true;
}

function findZeroAreaVertex(ring: ReadonlyArray<Pt>, indices: readonly number[]): number {
  const m = indices.length;
  for (let i = 0; i < m; i++) {
    const a = ring[indices[(i + m - 1) % m]];
    const b = ring[indices[i]];
    const c = ring[indices[(i + 1) % m]];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) <= EPS_CROSS) return i;
  }
  return -1;
}

/** Triangulated ring set: a deduplicated point list plus index triples. */
export interface TriangulatedRings {
  points: Pt[];
  triangles: number[][];
}

/**
 * Triangulate a bag of rings under the even-odd rule. This is the single entry
 * point both fill consumers call; see the module comment for why.
 *
 * A hole-free ring set takes the same path it always did — the ring is handed
 * straight to {@link earClip} in its original vertex order — so profiles
 * without holes are byte-identical to before #2516.
 */
export function triangulateRings(rings: readonly (readonly Pt[])[]): TriangulatedRings {
  const points: Pt[] = [];
  const triangles: number[][] = [];

  for (const group of groupRingsByNesting(rings)) {
    const stitched =
      group.holes.length === 0 ? group.outer : joinHoles(group.outer, group.holes);
    const tris = earClip(stitched);
    if (tris.length === 0) continue;
    const base = points.length;
    for (const p of stitched) points.push(p);
    for (const [a, b, c] of tris) triangles.push([base + a, base + b, base + c]);
  }

  return { points, triangles };
}
