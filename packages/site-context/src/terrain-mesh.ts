/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Elevation grid → terrain meshes: square chunks of grid cells, each with its
 * own origin, plus a skirt around the outer edge.
 *
 * Grid convention (from `@ifc-lite/geodata-ch`): values at nodes,
 * `x = origin.x + col·res`, `y = origin.y − row·res`, rows north to south,
 * `NaN` where there is no data. A cell with a `NaN` corner is dropped, never
 * filled. Normals come from central differences over the whole grid, so the
 * vertices two chunks share get the same normal.
 */

import type { ElevationGrid } from '@ifc-lite/geodata-ch';
import type { SiteContextMesh } from './types.js';

/** Grid cells per chunk side. */
export const CHUNK_CELLS = 128;
/** The skirt reaches this far below the lowest terrain height, in metres. */
export const SKIRT_DEPTH = 5;

export type TerrainGrid = Pick<ElevationGrid, 'origin' | 'resolution' | 'width' | 'height' | 'values'>;

export interface TerrainChunk {
  row: number;
  col: number;
  origin: [number, number, number];
  mesh: SiteContextMesh;
  cells: number;
}

export interface TerrainMeshResult {
  chunks: TerrainChunk[];
  skirt: { origin: [number, number, number]; mesh: SiteContextMesh; segments: number } | null;
  /** Cells dropped because a corner had no data. */
  droppedCells: number;
  /** Chunks with no cell left, not emitted. */
  emptyChunks: number;
  /** Outer-edge segments without a skirt wall because an end had no data. */
  skirtGaps: number;
  minHeight: number;
  maxHeight: number;
}

function heightAt(g: TerrainGrid, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return NaN;
  return g.values[row * g.width + col];
}

/** Bilinear height at an EPSG:2056 point; `NaN` outside the grid or next to missing data. */
export function sampleTerrain(g: TerrainGrid, x: number, y: number): number {
  const fc = (x - g.origin.x) / g.resolution;
  const fr = (g.origin.y - y) / g.resolution;
  if (fc < -1e-9 || fr < -1e-9 || fc > g.width - 1 + 1e-9 || fr > g.height - 1 + 1e-9) return NaN;
  const c = Math.min(Math.max(Math.floor(fc), 0), g.width - 2);
  const r = Math.min(Math.max(Math.floor(fr), 0), g.height - 2);
  const tx = fc - c;
  const ty = fr - r;
  const h00 = heightAt(g, c, r);
  const h10 = heightAt(g, c + 1, r);
  const h01 = heightAt(g, c, r + 1);
  const h11 = heightAt(g, c + 1, r + 1);
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

function slope(a: number, h: number, b: number, step: number): number {
  const fa = Number.isFinite(a);
  const fb = Number.isFinite(b);
  if (fa && fb) return (b - a) / (2 * step);
  if (fb) return (b - h) / step;
  if (fa) return (h - a) / step;
  return 0;
}

function nodeNormal(g: TerrainGrid, col: number, row: number, out: Float32Array, at: number): void {
  const h = heightAt(g, col, row);
  const dzdx = slope(heightAt(g, col - 1, row), h, heightAt(g, col + 1, row), g.resolution);
  // Rows run south, so north is row − 1.
  const dzdy = slope(heightAt(g, col, row + 1), h, heightAt(g, col, row - 1), g.resolution);
  const len = Math.hypot(dzdx, dzdy, 1);
  out[at] = -dzdx / len;
  out[at + 1] = -dzdy / len;
  out[at + 2] = 1 / len;
}

function cellIsComplete(g: TerrainGrid, col: number, row: number): boolean {
  return (
    Number.isFinite(heightAt(g, col, row)) &&
    Number.isFinite(heightAt(g, col + 1, row)) &&
    Number.isFinite(heightAt(g, col, row + 1)) &&
    Number.isFinite(heightAt(g, col + 1, row + 1))
  );
}

function buildChunk(g: TerrainGrid, c0: number, c1: number, r0: number, r1: number, h0: number): TerrainChunk | null {
  const res = g.resolution;
  const nodeCols = c1 - c0 + 1;
  const vertexOf = new Int32Array(nodeCols * (r1 - r0 + 1)).fill(-1);
  const keep: number[] = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) if (cellIsComplete(g, c, r)) keep.push(c, r);
  }
  if (keep.length === 0) return null;
  const used: number[] = [];
  const vid = (c: number, r: number): number => {
    const k = (r - r0) * nodeCols + (c - c0);
    if (vertexOf[k] < 0) {
      vertexOf[k] = used.length / 2;
      used.push(c, r);
    }
    return vertexOf[k];
  };
  const indices = new Uint32Array((keep.length / 2) * 6);
  for (let i = 0, t = 0; i < keep.length; i += 2) {
    const c = keep[i];
    const r = keep[i + 1];
    const nw = vid(c, r);
    const ne = vid(c + 1, r);
    const sw = vid(c, r + 1);
    const se = vid(c + 1, r + 1);
    // Counter-clockwise seen from above (x east, y north, z up).
    indices.set([sw, se, ne, sw, ne, nw], t);
    t += 6;
  }
  const n = used.length / 2;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const c = used[2 * v];
    const r = used[2 * v + 1];
    positions[3 * v] = (c - c0) * res;
    positions[3 * v + 1] = (r1 - r) * res;
    positions[3 * v + 2] = heightAt(g, c, r) - h0;
    nodeNormal(g, c, r, normals, 3 * v);
    uvs[2 * v] = c / (g.width - 1);
    uvs[2 * v + 1] = r / (g.height - 1);
  }
  return {
    row: r0 / CHUNK_CELLS,
    col: c0 / CHUNK_CELLS,
    origin: [g.origin.x + c0 * res, g.origin.y - r1 * res, h0],
    mesh: { positions, normals, uvs, indices },
    cells: keep.length / 2,
  };
}

/** Outer-edge nodes counter-clockwise seen from above, starting at the south-west corner. */
function perimeter(g: TerrainGrid): Array<[number, number]> {
  const w = g.width - 1;
  const h = g.height - 1;
  const out: Array<[number, number]> = [];
  for (let c = 0; c < w; c++) out.push([c, h]);
  for (let r = h; r > 0; r--) out.push([w, r]);
  for (let c = w; c > 0; c--) out.push([c, 0]);
  for (let r = 0; r < h; r++) out.push([0, r]);
  return out;
}

function buildSkirt(g: TerrainGrid, h0: number, bottom: number): { mesh: SiteContextMesh; segments: number; gaps: number } {
  const res = g.resolution;
  const ring = perimeter(g);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const zb = bottom - h0;
  let gaps = 0;
  let segments = 0;
  const push = (c: number, r: number, z: number, nx: number, ny: number, nz: number) => {
    pos.push(c * res, (g.height - 1 - r) * res, z);
    nor.push(nx, ny, nz);
    uv.push(c / (g.width - 1), r / (g.height - 1));
    return pos.length / 3 - 1;
  };
  for (let i = 0; i < ring.length; i++) {
    const [pc, pr] = ring[i];
    const [qc, qr] = ring[(i + 1) % ring.length];
    const hp = heightAt(g, pc, pr);
    const hq = heightAt(g, qc, qr);
    if (!Number.isFinite(hp) || !Number.isFinite(hq)) {
      gaps++;
      continue;
    }
    // Direction of travel in (east, north); outward is to its right.
    const dx = Math.sign(qc - pc);
    const dy = Math.sign(pr - qr);
    const nx = dy;
    const ny = -dx;
    const pb = push(pc, pr, zb, nx, ny, 0);
    const qb = push(qc, qr, zb, nx, ny, 0);
    const qt = push(qc, qr, hq - h0, nx, ny, 0);
    const pt = push(pc, pr, hp - h0, nx, ny, 0);
    idx.push(pb, qb, qt, pb, qt, pt);
    segments++;
  }
  // Bottom plate, facing down.
  const w = g.width - 1;
  const h = g.height - 1;
  const sw = push(0, h, zb, 0, 0, -1);
  const se = push(w, h, zb, 0, 0, -1);
  const ne = push(w, 0, zb, 0, 0, -1);
  const nw = push(0, 0, zb, 0, 0, -1);
  idx.push(sw, nw, ne, sw, ne, se);
  return {
    mesh: {
      positions: Float32Array.from(pos),
      normals: Float32Array.from(nor),
      uvs: Float32Array.from(uv),
      indices: Uint32Array.from(idx),
    },
    segments,
    gaps,
  };
}

export function buildTerrainMeshes(g: TerrainGrid, h0: number): TerrainMeshResult {
  if (g.width < 2 || g.height < 2) throw new RangeError(`terrain grid needs at least 2 × 2 nodes, got ${g.width} × ${g.height}`);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const v of g.values) {
    if (v < minHeight) minHeight = v;
    if (v > maxHeight) maxHeight = v;
  }
  const chunks: TerrainChunk[] = [];
  let emptyChunks = 0;
  let keptCells = 0;
  for (let r0 = 0; r0 < g.height - 1; r0 += CHUNK_CELLS) {
    for (let c0 = 0; c0 < g.width - 1; c0 += CHUNK_CELLS) {
      const chunk = buildChunk(g, c0, Math.min(c0 + CHUNK_CELLS, g.width - 1), r0, Math.min(r0 + CHUNK_CELLS, g.height - 1), h0);
      if (chunk) {
        chunks.push(chunk);
        keptCells += chunk.cells;
      } else emptyChunks++;
    }
  }
  const droppedCells = (g.width - 1) * (g.height - 1) - keptCells;
  let skirt: TerrainMeshResult['skirt'] = null;
  let skirtGaps = 0;
  if (Number.isFinite(minHeight)) {
    const s = buildSkirt(g, h0, minHeight - SKIRT_DEPTH);
    skirtGaps = s.gaps;
    skirt = { origin: [g.origin.x, g.origin.y - (g.height - 1) * g.resolution, h0], mesh: s.mesh, segments: s.segments };
  }
  return { chunks, skirt, droppedCells, emptyChunks, skirtGaps, minHeight, maxHeight };
}
