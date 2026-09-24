/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stage 1 of the outlier-robust camera fit (#5387, #5633): find small clusters
 * of meshes that sit detached from the model, such as the coordination-marker
 * proxies (an `origin` cube, a `geo-reference` glyph) the buildingSMART
 * samples place at the coordination origin. They are left out of the framing
 * box only; they stay rendered and inside the full bounds used for clipping.
 *
 * Mesh boxes are clustered on a coarse grid (touching or neighbouring cells
 * join); the main cluster holds the most meshes (ties: the larger box). A
 * cluster is detached when it is far for its own size (gap to the main
 * cluster over DETACHED_GAP_OVER_OWN_SIZE of its own diagonals) and either
 *  - FAR: clearly smaller than the model (≤ DETACHED_FAR_MAX_SIZE_OF_MAIN of
 *    its diagonal) and more than DETACHED_GAP_OVER_MAIN_SIZE model lengths
 *    out (Building-Architecture's glyph, 2.2x); or
 *  - TINY: at most DETACHED_MAX_SIZE_OF_MAIN of the model's size, and either
 *    at least DETACHED_TINY_MIN_GAP_OVER_MAIN model lengths out, or made up
 *    only of IfcBuildingElementProxy meshes, the coordination-marker
 *    convention (Infra-Bridge's and Infra-Rail's glyphs sit 0.5-0.8 model
 *    lengths out). A lamp post or a shrub near the building is typed as what
 *    it is, so it stays framed (#5633).
 * Only a strict minority of meshes is ever dropped, across all passes.
 *
 * Clustering repeats on what is kept (up to CLUSTER_PASSES): one stray point
 * a kilometre out makes the first pass's cells so coarse that the model and a
 * nearby marker share a cell; once the stray point is gone, the next pass sees
 * them apart (#5633).
 *
 * Cost per pass: O(meshes × cells each mesh's box covers), at most
 * (CLUSTER_GRID_CELLS + 1)^3 cells in total, so O(meshes) with a constant
 * that grows only for meshes spanning much of the model.
 */

const CLUSTER_GRID_CELLS = 10;
const CLUSTER_PASSES = 3;
const DETACHED_GAP_OVER_OWN_SIZE = 3;
const DETACHED_MAX_SIZE_OF_MAIN = 0.1;
const DETACHED_TINY_MIN_GAP_OVER_MAIN = 1;
const DETACHED_GAP_OVER_MAIN_SIZE = 2;
const DETACHED_FAR_MAX_SIZE_OF_MAIN = 0.6;
/** Fewer meshes than this during streaming: the first batch is not the model
 *  yet, so framing a subset of it could crop real structure (#5633). */
export const DETACHED_MIN_MESHES_WHILE_STREAMING = 8;

/**
 * Mark the meshes to leave out of the framing box, or return null when there
 * are none. `bb[i]` is mesh i's box `[minX, minY, minZ, maxX, maxY, maxZ]`;
 * `proxy[i]` says whether mesh i is an IfcBuildingElementProxy.
 */
export function detachedMinorityClusters(
  bb: readonly Float64Array[],
  proxy: readonly boolean[],
  opts: { streaming?: boolean } = {},
): boolean[] | null {
  const count = bb.length;
  if (count < 3 || (opts.streaming && count < DETACHED_MIN_MESHES_WHILE_STREAMING)) return null;
  const dropped: boolean[] = new Array<boolean>(count).fill(false);
  let droppedCount = 0;
  let kept = Array.from({ length: count }, (_, i) => i);
  for (let pass = 0; pass < CLUSTER_PASSES && kept.length >= 3; pass++) {
    const drop = onePass(kept.map((i) => bb[i]), kept.map((i) => proxy[i]));
    if (!drop) break;
    const next: number[] = [];
    kept.forEach((i, j) => { if (drop[j]) { dropped[i] = true; droppedCount++; } else next.push(i); });
    kept = next;
  }
  if (droppedCount === 0 || droppedCount >= count - droppedCount) return null;
  return dropped;
}

function onePass(bb: readonly Float64Array[], proxy: readonly boolean[]): boolean[] | null {
  const count = bb.length;
  let fMinX = Infinity, fMinY = Infinity, fMinZ = Infinity, fMaxX = -Infinity, fMaxY = -Infinity, fMaxZ = -Infinity;
  for (const b of bb) {
    if (b[0] < fMinX) fMinX = b[0]; if (b[1] < fMinY) fMinY = b[1]; if (b[2] < fMinZ) fMinZ = b[2];
    if (b[3] > fMaxX) fMaxX = b[3]; if (b[4] > fMaxY) fMaxY = b[4]; if (b[5] > fMaxZ) fMaxZ = b[5];
  }
  const cell = Math.hypot(fMaxX - fMinX, fMaxY - fMinY, fMaxZ - fMinZ) / CLUSTER_GRID_CELLS;
  if (!(cell > 0) || !Number.isFinite(cell)) return null;
  const [nx, ny, nz] = [fMaxX - fMinX, fMaxY - fMinY, fMaxZ - fMinZ].map((d) => Math.floor(d / cell) + 1);
  const at = (v: number, min: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((v - min) / cell)));
  const occupied = new Uint8Array(nx * ny * nz);
  const firstCell = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const b = bb[i];
    const x0 = at(b[0], fMinX, nx), y0 = at(b[1], fMinY, ny), z0 = at(b[2], fMinZ, nz);
    const x1 = at(b[3], fMinX, nx), y1 = at(b[4], fMinY, ny), z1 = at(b[5], fMinZ, nz);
    firstCell[i] = (z0 * ny + y0) * nx + x0;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) occupied[(z * ny + y) * nx + x] = 1;
  }
  // Label occupied cells into 26-connected components, iteratively.
  const label = new Int32Array(occupied.length).fill(-1);
  let labels = 0;
  const stack: number[] = [];
  for (let c = 0; c < occupied.length; c++) {
    if (!occupied[c] || label[c] >= 0) continue;
    label[c] = labels;
    stack.push(c);
    while (stack.length) {
      const cur = stack.pop()!;
      const x = cur % nx, y = Math.floor(cur / nx) % ny, z = Math.floor(cur / (nx * ny));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const n = (Z * ny + Y) * nx + X;
        if (occupied[n] && label[n] < 0) { label[n] = labels; stack.push(n); }
      }
    }
    labels++;
  }
  if (labels < 2) return null;
  // Per cluster: mesh count, union box, and whether every mesh is a proxy.
  const meshes = new Int32Array(labels);
  const allProxy = new Uint8Array(labels).fill(1);
  const box = Array.from({ length: labels }, () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const clusterOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = label[firstCell[i]];
    clusterOf[i] = k;
    meshes[k]++;
    if (!proxy[i]) allProxy[k] = 0;
    const b = bb[i], u = box[k];
    for (let a = 0; a < 3; a++) { if (b[a] < u[a]) u[a] = b[a]; if (b[a + 3] > u[a + 3]) u[a + 3] = b[a + 3]; }
  }
  const diag = (u: number[]) => Math.hypot(u[3] - u[0], u[4] - u[1], u[5] - u[2]);
  let main = 0;
  for (let k = 1; k < labels; k++) {
    if (meshes[k] > meshes[main] || (meshes[k] === meshes[main] && diag(box[k]) > diag(box[main]))) main = k;
  }
  const mainBox = box[main], mainDiag = diag(mainBox);
  const drop = new Uint8Array(labels);
  let dropped = 0;
  for (let k = 0; k < labels; k++) {
    if (k === main) continue;
    const u = box[k];
    const gap = Math.hypot(
      Math.max(0, u[0] - mainBox[3], mainBox[0] - u[3]),
      Math.max(0, u[1] - mainBox[4], mainBox[1] - u[4]),
      Math.max(0, u[2] - mainBox[5], mainBox[2] - u[5]),
    );
    const own = diag(u);
    if (!(gap > DETACHED_GAP_OVER_OWN_SIZE * own)) continue;
    const far = own <= DETACHED_FAR_MAX_SIZE_OF_MAIN * mainDiag && gap > DETACHED_GAP_OVER_MAIN_SIZE * mainDiag;
    const tiny = own <= DETACHED_MAX_SIZE_OF_MAIN * mainDiag
      && (gap >= DETACHED_TINY_MIN_GAP_OVER_MAIN * mainDiag || allProxy[k] === 1);
    if (far || tiny) { drop[k] = 1; dropped += meshes[k]; }
  }
  if (dropped === 0 || dropped >= count - dropped) return null;
  return Array.from(clusterOf, (k) => drop[k] === 1);
}
