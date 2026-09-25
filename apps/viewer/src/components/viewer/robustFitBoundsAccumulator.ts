/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Outlier-robust camera-fit bounds, and an incremental accumulator for the
 * same computation.
 *
 * `robustFitBoundsFull` is the original full-rescan algorithm (issue #1394):
 * every call walks every vertex of every mesh passed in. It is the reference
 * the incremental accumulator is checked against in tests, and Fit All runs
 * it at click time over the visible entities' boxes (#5884); the streaming
 * hot path uses the accumulator.
 *
 * `createRobustFitBoundsAccumulator` produces the same `{ full, robust }`
 * result but does so incrementally: it remembers which mesh indices of a
 * given array (by reference) it has already folded into its running sums,
 * and on each `update()` only walks the vertices of meshes appended since
 * the last call. During streaming, `useGeometryStreaming` mutates the same
 * `MeshData[]` array in place (push) and calls `update()` on every commit
 * while the camera has not yet fitted — see dataSlice.ts `appendGeometryBatch`
 * for the array-identity contract this relies on.
 *
 * The per-mesh bounding-box / centroid / weight arrays (`cx`, `cy`, `cz`,
 * `w`, `bb`) are appended to in the exact same index order as the original
 * single-pass loop, so the folded reductions (min/max, weighted centroid
 * sums) are bit-for-bit identical to a full rescan — floating-point min/max
 * is order-independent, and the summation order for the weighted centroid
 * is preserved exactly (indices 0..N in order, whether folded in one call
 * or across many). The final sort + cumulative "keep innermost mass" pass
 * still runs over the full accumulated mesh count on every call (it is not,
 * and cannot cheaply be made, incremental — the centroid it sorts around
 * shifts as new meshes arrive) but that is O(M log M) in mesh count, not
 * O(V) in vertex count, so it stays cheap relative to the vertex scan it
 * replaces.
 *
 * The fold has two stages. Stage 1 (#5387, #5633, `detachedClusters.ts`)
 * drops small clusters that sit detached from the model, such as the
 * coordination-marker proxies the buildingSMART samples place at the origin.
 * Stage 2 (#1394) is the vertex-mass trim above, applied to what stage 1 kept.
 */

import { detachedMinorityClusters } from './detachedClusters.js';

export type Bounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

export interface RobustFitMeshInput {
  positions: Float32Array | Float64Array;
  origin?: readonly [number, number, number] | null;
  /** IFC class; an `IfcBuildingElementProxy` may be a coordination marker (#5633). */
  ifcType?: string;
}

const isProxy = (m: RobustFitMeshInput) => m.ifcType === 'IfcBuildingElementProxy';

/** `streaming`: the mesh set is still growing (#5633), see detachedClusters.ts.
 *  `quiet`: no log line for a trim (Fit All runs this on every press). */
export interface RobustFitOptions { streaming?: boolean; quiet?: boolean }

const ROBUST_KEEP_MASS = 0.995;
const ROBUST_SHRINK_GUARD = 0.66;
// Real building coordinates can be hundreds of thousands of millimetres from
// the origin (models that keep mm with no RTC shift) — this is a garbage
// filter, not a "far from origin" filter, so it is far looser than
// computeBounds' 10 km guard.
const ROBUST_GARBAGE_COORD = 1e12;

/**
 * Reference implementation: full O(V) rescan of every mesh's vertices plus
 * an O(M log M) sort, on every call. This is the pre-optimization algorithm,
 * kept for equivalence testing against the incremental accumulator below.
 */
export function robustFitBoundsFull(meshes: readonly RobustFitMeshInput[], opts: RobustFitOptions = {}): { full: Bounds; robust: Bounds | null } | null {
  let fMinX = Infinity, fMinY = Infinity, fMinZ = Infinity;
  let fMaxX = -Infinity, fMaxY = -Infinity, fMaxZ = -Infinity;
  const cx: number[] = [], cy: number[] = [], cz: number[] = [], w: number[] = [];
  const bb: Float64Array[] = [];
  const proxy: boolean[] = [];
  let cwX = 0, cwY = 0, cwZ = 0, totalW = 0;
  for (let gi = 0; gi < meshes.length; gi++) {
    const positions = meshes[gi].positions;
    const o = meshes[gi].origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    let n = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
      if (Math.abs(x) < ROBUST_GARBAGE_COORD && Math.abs(y) < ROBUST_GARBAGE_COORD && Math.abs(z) < ROBUST_GARBAGE_COORD) {
        if (x < mnX) mnX = x; if (y < mnY) mnY = y; if (z < mnZ) mnZ = z;
        if (x > mxX) mxX = x; if (y > mxY) mxY = y; if (z > mxZ) mxZ = z;
        n++;
      }
    }
    if (n > 0) {
      if (mnX < fMinX) fMinX = mnX; if (mnY < fMinY) fMinY = mnY; if (mnZ < fMinZ) fMinZ = mnZ;
      if (mxX > fMaxX) fMaxX = mxX; if (mxY > fMaxY) fMaxY = mxY; if (mxZ > fMaxZ) fMaxZ = mxZ;
      const mcx = (mnX + mxX) / 2, mcy = (mnY + mxY) / 2, mcz = (mnZ + mxZ) / 2;
      cx.push(mcx); cy.push(mcy); cz.push(mcz); w.push(n);
      bb.push(Float64Array.of(mnX, mnY, mnZ, mxX, mxY, mxZ));
      proxy.push(isProxy(meshes[gi]));
      cwX += mcx * n; cwY += mcy * n; cwZ += mcz * n; totalW += n;
    }
  }
  return foldRobustBounds(fMinX, fMinY, fMinZ, fMaxX, fMaxY, fMaxZ, cx, cy, cz, w, bb, proxy, cwX, cwY, cwZ, totalW, opts);
}

/** Shared tail: sort-and-trim step, identical between the full and incremental paths. */
function foldRobustBounds(
  fMinX: number, fMinY: number, fMinZ: number,
  fMaxX: number, fMaxY: number, fMaxZ: number,
  cx: number[], cy: number[], cz: number[], w: number[], bb: Float64Array[], proxy: boolean[],
  cwX: number, cwY: number, cwZ: number, totalW: number, opts: RobustFitOptions,
): { full: Bounds; robust: Bounds | null } | null {
  const count = w.length;
  const fullMaxSize = Math.max(fMaxX - fMinX, fMaxY - fMinY, fMaxZ - fMinZ);
  // No usable geometry → no bounds at all.
  if (count === 0 || totalW <= 0 || !(fullMaxSize > 0) || !Number.isFinite(fullMaxSize)) return null;
  const full: Bounds = { min: { x: fMinX, y: fMinY, z: fMinZ }, max: { x: fMaxX, y: fMaxY, z: fMaxZ } };

  // Stage 1 (#5387): drop small clusters detached from the model, whatever
  // their vertex mass. A coordination-marker glyph can carry most of a small
  // model's vertices (buildingSMART's Building-Architecture: 1272 of 1884), so
  // the mass trim below can never reach it.
  const detached = detachedMinorityClusters(bb, proxy, opts);
  let candidates: number[];
  if (detached) {
    candidates = [];
    cwX = 0; cwY = 0; cwZ = 0; totalW = 0;
    for (let i = 0; i < count; i++) {
      if (detached[i]) continue;
      candidates.push(i);
      cwX += cx[i] * w[i]; cwY += cy[i] * w[i]; cwZ += cz[i] * w[i]; totalW += w[i];
    }
  } else {
    candidates = Array.from({ length: count }, (_, i) => i);
  }

  // Stage 2 (#1394): the innermost ROBUST_KEEP_MASS of vertex mass. Too few
  // meshes to reason about a mass tail below 8.
  let keptIdx = candidates;
  if (candidates.length >= 8 && totalW > 0) {
    const ctrX = cwX / totalW, ctrY = cwY / totalW, ctrZ = cwZ / totalW;
    const order = candidates.slice();
    order.sort((a, b) => {
      const da = (cx[a] - ctrX) ** 2 + (cy[a] - ctrY) ** 2 + (cz[a] - ctrZ) ** 2;
      const db = (cx[b] - ctrX) ** 2 + (cy[b] - ctrY) ** 2 + (cz[b] - ctrZ) ** 2;
      return da - db;
    });
    const keepTarget = ROBUST_KEEP_MASS * totalW;
    let cum = 0, n = 0;
    while (n < order.length && cum < keepTarget) cum += w[order[n++]];
    keptIdx = order.slice(0, n);
  }
  const kept = keptIdx.length;
  if (kept >= count) return { full, robust: null }; // nothing dropped → no override

  let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
  let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
  for (const i of keptIdx) {
    const b = bb[i];
    if (b[0] < rMinX) rMinX = b[0]; if (b[1] < rMinY) rMinY = b[1]; if (b[2] < rMinZ) rMinZ = b[2];
    if (b[3] > rMaxX) rMaxX = b[3]; if (b[4] > rMaxY) rMaxY = b[4]; if (b[5] > rMaxZ) rMaxZ = b[5];
  }
  const robustMaxSize = Math.max(rMaxX - rMinX, rMaxY - rMinY, rMaxZ - rMinZ);
  // Tail isn't inflating the box → no override (compact models unaffected).
  if (!(robustMaxSize < fullMaxSize * ROBUST_SHRINK_GUARD)) return { full, robust: null };

  if (!opts.quiet) console.log(
    `[GeomStream] outlier-robust camera fit: dropped ${count - kept} far mesh(es) from framing, ` +
    `extent ${Math.round(fullMaxSize)} → ${Math.round(robustMaxSize)} units`,
  );
  return { full, robust: { min: { x: rMinX, y: rMinY, z: rMinZ }, max: { x: rMaxX, y: rMaxY, z: rMaxZ } } };
}

export interface RobustFitBoundsAccumulator {
  /** Fold any meshes appended since the last call (by array identity + length)
   *  into the running state, then return the same shape as `robustFitBoundsFull`. */
  update(meshes: readonly RobustFitMeshInput[], opts?: RobustFitOptions): { full: Bounds; robust: Bounds | null } | null;
  /** Drop all cached state. Call on new-file / cleared-geometry transitions
   *  for memory hygiene — `update()` also self-resets on array-identity or
   *  length-shrink changes, so this is not required for correctness. */
  reset(): void;
}

export function createRobustFitBoundsAccumulator(): RobustFitBoundsAccumulator {
  let sourceRef: readonly RobustFitMeshInput[] | null = null;
  let scannedLen = 0;
  let fMinX = Infinity, fMinY = Infinity, fMinZ = Infinity;
  let fMaxX = -Infinity, fMaxY = -Infinity, fMaxZ = -Infinity;
  let cx: number[] = [], cy: number[] = [], cz: number[] = [], w: number[] = [];
  let bb: Float64Array[] = [];
  let proxy: boolean[] = [];
  let cwX = 0, cwY = 0, cwZ = 0, totalW = 0;

  function resetState(): void {
    sourceRef = null;
    scannedLen = 0;
    fMinX = Infinity; fMinY = Infinity; fMinZ = Infinity;
    fMaxX = -Infinity; fMaxY = -Infinity; fMaxZ = -Infinity;
    cx = []; cy = []; cz = []; w = [];
    bb = [];
    proxy = [];
    cwX = 0; cwY = 0; cwZ = 0; totalW = 0;
  }

  function update(meshes: readonly RobustFitMeshInput[], opts: RobustFitOptions = {}): { full: Bounds; robust: Bounds | null } | null {
    // New source array, or it shrank (new file / replace) → fold from scratch.
    if (sourceRef !== meshes || meshes.length < scannedLen) {
      resetState();
      sourceRef = meshes;
    }

    for (let gi = scannedLen; gi < meshes.length; gi++) {
      const positions = meshes[gi].positions;
      const o = meshes[gi].origin;
      const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
      let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
      let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
      let n = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
        if (Math.abs(x) < ROBUST_GARBAGE_COORD && Math.abs(y) < ROBUST_GARBAGE_COORD && Math.abs(z) < ROBUST_GARBAGE_COORD) {
          if (x < mnX) mnX = x; if (y < mnY) mnY = y; if (z < mnZ) mnZ = z;
          if (x > mxX) mxX = x; if (y > mxY) mxY = y; if (z > mxZ) mxZ = z;
          n++;
        }
      }
      if (n > 0) {
        if (mnX < fMinX) fMinX = mnX; if (mnY < fMinY) fMinY = mnY; if (mnZ < fMinZ) fMinZ = mnZ;
        if (mxX > fMaxX) fMaxX = mxX; if (mxY > fMaxY) fMaxY = mxY; if (mxZ > fMaxZ) fMaxZ = mxZ;
        const mcx = (mnX + mxX) / 2, mcy = (mnY + mxY) / 2, mcz = (mnZ + mxZ) / 2;
        cx.push(mcx); cy.push(mcy); cz.push(mcz); w.push(n);
        bb.push(Float64Array.of(mnX, mnY, mnZ, mxX, mxY, mxZ));
        proxy.push(isProxy(meshes[gi]));
        cwX += mcx * n; cwY += mcy * n; cwZ += mcz * n; totalW += n;
      }
    }
    scannedLen = meshes.length;

    return foldRobustBounds(fMinX, fMinY, fMinZ, fMaxX, fMaxY, fMaxZ, cx, cy, cz, w, bb, proxy, cwX, cwY, cwZ, totalW, opts);
  }

  return { update, reset: resetState };
}
