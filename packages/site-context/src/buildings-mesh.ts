/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One neighbouring building's triangles, made renderable single-sided:
 * consistent outward winding, flat normals, and the triangles grouped into a
 * `roof` part and a `wall` part.
 *
 * swissBUILDINGS3D tiles are double-sided with mixed triangle winding, so
 * neither the winding nor the stored normals say which side is outside.
 * The tiles (release 20260520) also store every face twice, identical, and
 * the faces where a wall solid meets its roof solid once in each part with
 * opposite winding. Copies are kept once and those interface faces, which
 * are inside the building, are left out; both are counted. Then winding is
 * made consistent across every edge two triangles share (vertices welded at
 * 1 mm), one connected piece at a time; each piece is then turned
 * so that its area-weighted normals point away from the building's centre
 * (`Σ (c_t − C) · n_t A_t > 0`, which for a closed piece is three times its
 * volume, whatever `C` is). A flat piece seen edge-on from `C` faces up.
 * Normals are then recomputed per triangle from the final winding, so
 * vertices are not shared between triangles.
 */

import type { SiteContextMesh, SiteContextMeshPart } from './types.js';

export type BuildingPart = 'roof' | 'wall';
export const PART_ORDER: readonly BuildingPart[] = ['roof', 'wall'];

/** Welding grid for adjacency, metres. */
const WELD = 1e-3;
/** Triangles with less area than this (m²) carry no direction and are dropped (counted). */
const MIN_AREA = 1e-8;

export interface BuildingMeshInput {
  /** Vertex positions in the feature's local frame (x east, y north, z up), f64. */
  positions: Float64Array;
  indices: Uint32Array;
  /** Part of each triangle. */
  partOf: Uint8Array;
}

export interface BuildingMeshResult {
  mesh: SiteContextMesh;
  /** Zero-area triangles left out. */
  degenerate: number;
  /** Repeated copies of a face in the same part, left out. */
  duplicates: number;
  /** Faces present in both parts (where a wall solid meets the roof solid, inside the building), left out. */
  interior: number;
  /** Connected pieces whose orientation was decided (closed shells, roof planes, …). */
  pieces: number;
  /** Pieces that were turned over to face outwards. */
  flippedPieces: number;
}

function cross(p: Float64Array, a: number, b: number, c: number): [number, number, number] {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function weld(positions: Float64Array): Uint32Array {
  const ids = new Map<string, number>();
  const out = new Uint32Array(positions.length / 3);
  for (let v = 0; v < out.length; v++) {
    const key = `${Math.round(positions[v * 3] / WELD)},${Math.round(positions[v * 3 + 1] / WELD)},${Math.round(positions[v * 3 + 2] / WELD)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    out[v] = id;
  }
  return out;
}

/**
 * Per kept triangle, whether to reverse its winding. Iterative flood over
 * manifold edges (exactly two triangles): a visited set bounds the work.
 */
function orient(input: BuildingMeshInput, keep: number[], welded: Uint32Array): { flip: Uint8Array; pieces: number; flippedPieces: number } {
  const { positions: p, indices } = input;
  const n = keep.length;
  const edges = new Map<number, number[]>();
  const span = welded.length + 1;
  for (let k = 0; k < n; k++) {
    const t = keep[k];
    for (let e = 0; e < 3; e++) {
      const a = welded[indices[t * 3 + e]], b = welded[indices[t * 3 + ((e + 1) % 3)]];
      const key = a < b ? a * span + b : b * span + a;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      list.push(a < b ? k : ~k); // sign records the direction the triangle walks the edge
    }
  }
  const flip = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const neighbours = (k: number): Array<[number, boolean]> => {
    const t = keep[k];
    const out: Array<[number, boolean]> = [];
    for (let e = 0; e < 3; e++) {
      const a = welded[indices[t * 3 + e]], b = welded[indices[t * 3 + ((e + 1) % 3)]];
      const list = edges.get(a < b ? a * span + b : b * span + a)!;
      if (list.length !== 2) continue;
      const other = list[0] === (a < b ? k : ~k) ? list[1] : list[0];
      const j = other < 0 ? ~other : other;
      if (j === k) continue;
      // Same direction on the shared edge means opposite windings: the neighbour must flip relative to k.
      out.push([j, other < 0 === !(a < b)]);
    }
    return out;
  };
  // Building centre: the middle of the bounding box.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let pieces = 0;
  let flippedPieces = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    pieces++;
    const members: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const k = stack.pop()!;
      members.push(k);
      for (const [j, sameDirection] of neighbours(k)) {
        if (seen[j]) continue;
        seen[j] = 1;
        flip[j] = sameDirection ? flip[k] ^ 1 : flip[k];
        stack.push(j);
      }
    }
    let outward = 0;
    let up = 0;
    for (const k of members) {
      const t = keep[k];
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      const s = flip[k] ? -1 : 1;
      const nrm = cross(p, a, b, c);
      for (let d = 0; d < 3; d++) {
        const ct = (p[a * 3 + d] + p[b * 3 + d] + p[c * 3 + d]) / 3;
        outward += s * (ct - centre[d]) * nrm[d];
      }
      up += s * nrm[2];
    }
    const scale = Math.max(1e-12, Math.abs(up));
    if (outward < -1e-9 * scale || (Math.abs(outward) <= 1e-9 * scale && up < 0)) {
      flippedPieces++;
      for (const k of members) flip[k] ^= 1;
    }
  }
  return { flip, pieces, flippedPieces };
}

/** Unwelded flat-shaded mesh, roof triangles first, then walls; `parts` names the two ranges. */
export function buildBuildingMesh(input: BuildingMeshInput): BuildingMeshResult {
  const { positions: p, indices, partOf } = input;
  const welded = weld(p);
  const faces = new Map<string, number[]>();
  let degenerate = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const [x, y, z] = cross(p, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
    if (Math.hypot(x, y, z) / 2 < MIN_AREA) {
      degenerate++;
      continue;
    }
    const key = [welded[indices[t * 3]], welded[indices[t * 3 + 1]], welded[indices[t * 3 + 2]]].sort((a, b) => a - b).join(',');
    const list = faces.get(key);
    if (list) list.push(t);
    else faces.set(key, [t]);
  }
  const keep: number[] = [];
  let duplicates = 0;
  let interior = 0;
  for (const list of faces.values()) {
    if (list.some((t) => partOf[t] !== partOf[list[0]])) interior += list.length;
    else {
      keep.push(list[0]);
      duplicates += list.length - 1;
    }
  }
  keep.sort((a, b) => a - b);
  const { flip, pieces, flippedPieces } = orient(input, keep, welded);
  const count = keep.length;
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const parts: SiteContextMeshPart[] = [];
  let tri = 0;
  for (let part = 0; part < PART_ORDER.length; part++) {
    const first = tri;
    for (let k = 0; k < count; k++) {
      const t = keep[k];
      if (partOf[t] !== part) continue;
      const a = indices[t * 3];
      const b = flip[k] ? indices[t * 3 + 2] : indices[t * 3 + 1];
      const c = flip[k] ? indices[t * 3 + 1] : indices[t * 3 + 2];
      const [nx, ny, nz] = cross(p, a, b, c);
      const len = Math.hypot(nx, ny, nz);
      const vs = [a, b, c];
      for (let v = 0; v < 3; v++) {
        const o = tri * 9 + v * 3;
        positions[o] = p[vs[v] * 3];
        positions[o + 1] = p[vs[v] * 3 + 1];
        positions[o + 2] = p[vs[v] * 3 + 2];
        normals[o] = nx / len;
        normals[o + 1] = ny / len;
        normals[o + 2] = nz / len;
      }
      tri++;
    }
    if (tri > first) parts.push({ name: PART_ORDER[part], firstIndex: first * 3, indexCount: (tri - first) * 3 });
  }
  const meshIndices = new Uint32Array(count * 3);
  for (let i = 0; i < meshIndices.length; i++) meshIndices[i] = i;
  return { mesh: { positions, normals, indices: meshIndices, parts }, degenerate, duplicates, interior, pieces, flippedPieces };
}
