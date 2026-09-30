/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ghosts for the Stair and Railing commands (charter #6232, D1): the stepped
 * flight and the rail with its posts, each as ONE mesh (the pointer's ghost
 * guard hides only the few ids after `commandGhostId`). Built in workplane-
 * local metres and mapped through the workplane like every command ghost, so
 * the preview stands where the commit writes.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { railingPostPoints } from '@ifc-lite/create';
import type { Vec2 } from '@/lib/snap/types';
import { prismGhostMesh } from './ghost-shapes.js';
import type { Vec3, Workplane } from './types.js';

/** Post and rail section of the ghost, metres. */
const POST = 0.05;
const RAIL = 0.05;
const GHOST_COLOR: MeshData['color'] = [0.25, 0.6, 1, 0.45];

/** One mesh out of several (they share the first one's colour); null when there are none. */
export function mergeGhostMeshes(meshes: readonly (MeshData | null)[], expressId: number): MeshData | null {
  const parts = meshes.filter((m): m is MeshData => m !== null);
  if (parts.length === 0) return null;
  const positions = new Float32Array(parts.reduce((n, m) => n + m.positions.length, 0));
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(parts.reduce((n, m) => n + m.indices.length, 0));
  let vertex = 0, index = 0;
  for (const m of parts) {
    positions.set(m.positions, vertex * 3);
    normals.set(m.normals, vertex * 3);
    for (let i = 0; i < m.indices.length; i++) indices[index + i] = m.indices[i] + vertex;
    vertex += m.positions.length / 3;
    index += m.indices.length;
  }
  return { expressId, positions, normals, indices, color: [...parts[0].color] as MeshData['color'] };
}

/** The flight as solid steps: step i covers x in [i·tread, (i+1)·tread] up to (i+1)·riser. */
export function stairGhostMesh(
  plane: Workplane,
  at: (x: number, y: number) => Vec2,
  risers: number,
  riser: number,
  tread: number,
  width: number,
  expressId: number,
): MeshData | null {
  const steps: (MeshData | null)[] = [];
  for (let i = 0; i < risers; i++) {
    const outline = [at(i * tread, -width / 2), at((i + 1) * tread, -width / 2), at((i + 1) * tread, width / 2), at(i * tread, width / 2)];
    steps.push(prismGhostMesh(plane, outline, 0, (i + 1) * riser, expressId));
  }
  return mergeGhostMeshes(steps, expressId);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quads of a hexahedron given as 4 bottom corners then the 4 above them, counter-clockwise from above. */
const BOX_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
];

/** A flat-shaded box from eight render-space corners; faces point away from its centre. */
function boxMesh(corners: readonly Vec3[], expressId: number): MeshData {
  const centre = [0, 0, 0];
  for (const c of corners) { centre[0] += c[0] / 8; centre[1] += c[1] / 8; centre[2] += c[2] / 8; }
  const positions = new Float32Array(BOX_FACES.length * 12);
  const normals = new Float32Array(BOX_FACES.length * 12);
  const indices = new Uint32Array(BOX_FACES.length * 6);
  BOX_FACES.forEach((face, f) => {
    let quad = face.map((i) => corners[i]);
    let n = cross(sub(quad[1], quad[0]), sub(quad[2], quad[0]));
    const outward = sub(quad[0], centre as unknown as Vec3);
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      quad = [quad[0], quad[3], quad[2], quad[1]];
      n = [-n[0], -n[1], -n[2]];
    }
    const len = Math.hypot(...n) || 1;
    quad.forEach((p, i) => {
      positions.set(p, f * 12 + i * 3);
      normals.set([n[0] / len, n[1] / len, n[2] / len], f * 12 + i * 3);
    });
    indices.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
  });
  return { expressId, positions, normals, indices, color: [...GHOST_COLOR] as MeshData['color'] };
}

/**
 * The rail as a box along each path segment (following any slope) and a post
 * at every `railingPostPoints` position. `path` and `height` are workplane-
 * local metres; `height` is the top of the rail above the path.
 */
export function railingGhostMesh(
  plane: Workplane,
  path: readonly Vec3[],
  height: number,
  spacing: number,
  expressId: number,
): MeshData | null {
  if (path.length < 2 || !(height > RAIL)) return null;
  const parts: MeshData[] = [];
  const railZ = height - RAIL / 2;
  const toRender = (p: Vec3) => plane.localToRender(p);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(run > 1e-9)) continue;
    const sx = (-(b[1] - a[1]) / run) * (RAIL / 2), sy = ((b[0] - a[0]) / run) * (RAIL / 2);
    const end = (p: Vec3, dz: number, side: number): Vec3 => toRender([p[0] + sx * side, p[1] + sy * side, p[2] + railZ + dz]);
    const c = [end(a, -RAIL / 2, -1), end(a, -RAIL / 2, 1), end(b, -RAIL / 2, 1), end(b, -RAIL / 2, -1),
      end(a, RAIL / 2, -1), end(a, RAIL / 2, 1), end(b, RAIL / 2, 1), end(b, RAIL / 2, -1)];
    parts.push(boxMesh(c, expressId));
  }
  for (const p of railingPostPoints(path.map((p) => [p[0], p[1], p[2]] as [number, number, number]), spacing)) {
    const foot = [[p[0] - POST / 2, p[1] - POST / 2], [p[0] + POST / 2, p[1] - POST / 2], [p[0] + POST / 2, p[1] + POST / 2], [p[0] - POST / 2, p[1] + POST / 2]];
    const c = [...foot.map((f) => toRender([f[0], f[1], p[2]])), ...foot.map((f) => toRender([f[0], f[1], p[2] + railZ]))];
    parts.push(boxMesh(c, expressId));
  }
  return mergeGhostMeshes(parts, expressId);
}
