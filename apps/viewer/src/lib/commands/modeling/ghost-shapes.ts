/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ghost shapes for modeling-command previews (charter #6232, M2): plan
 * outlines on the workplane and the one extruder that turns an outline into
 * a preview mesh. Every element the Model workspace draws is a vertical
 * prism over an outline — a wall or beam over its axis band, a slab over its
 * rectangle or polygon, a column over its rotated section — so one extruder
 * serves them all. Outlines are workplane-local metres; the mesh is mapped
 * through the workplane, so the preview sits where the commit writes.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from './types.js';

const GHOST_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.45];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Twice the signed area (CCW positive). */
export function signedArea2(outline: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area;
}

/** The band of `width` centred on segment a→b (a wall or beam footprint). Null when degenerate. */
export function segmentOutline(a: Vec2, b: Vec2, width: number): Vec2[] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-6) || !(width > 0)) return null;
  const nx = (-dy / length) * (width / 2), ny = (dx / length) * (width / 2);
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/** The axis-aligned rectangle with opposite corners `p` and `q`. */
export function rectOutline(p: Vec2, q: Vec2): Vec2[] {
  return [[p[0], p[1]], [q[0], p[1]], [q[0], q[1]], [p[0], q[1]]];
}

/** A `width` × `depth` rectangle centred on `centre`, turned `deg` counter-clockwise. */
export function centredRectOutline(centre: Vec2, width: number, depth: number, deg: number): Vec2[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const x = (sx * width) / 2, y = (sy * depth) / 2;
    return [centre[0] + x * c - y * s, centre[1] + x * s + y * c] as Vec2;
  });
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * Ear-clipping triangulation of a simple polygon (a slab outline may be
 * concave). Returns index triples into `outline`, counter-clockwise. A
 * self-intersecting outline falls back to a fan rather than looping.
 */
export function triangulateOutline(outline: readonly Vec2[]): [number, number, number][] {
  const ccw = signedArea2(outline) >= 0;
  const ring = outline.map((_, i) => i);
  if (!ccw) ring.reverse();
  const tris: [number, number, number][] = [];
  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ia = ring[(i + ring.length - 1) % ring.length], ib = ring[i], ic = ring[(i + 1) % ring.length];
      const a = outline[ia], b = outline[ib], c = outline[ic];
      const convex = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
      if (!convex) continue;
      if (ring.some((j) => j !== ia && j !== ib && j !== ic && pointInTriangle(outline[j], a, b, c))) continue;
      tris.push([ia, ib, ic]);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  for (let i = 1; i + 1 < ring.length; i++) tris.push([ring[0], ring[i], ring[i + 1]]);
  return tris;
}

/**
 * The vertical prism over `outline` from local z `z0` to `z1`, as a flat-shaded
 * ghost mesh with outward normals. Null for a degenerate outline or height.
 */
export function prismGhostMesh(
  plane: Workplane,
  outline: readonly Vec2[] | null,
  z0: number,
  z1: number,
  expressId: number,
): MeshData | null {
  if (!outline || outline.length < 3 || !(z1 - z0 > 1e-6) || Math.abs(signedArea2(outline)) < 1e-12) return null;
  const bottom = outline.map((p) => plane.localToRender([p[0], p[1], z0]));
  const top = outline.map((p) => plane.localToRender([p[0], p[1], z1]));
  const up = plane.plane.normal;
  const down: Vec3 = [-up[0], -up[1], -up[2]];
  // Outward for a side is the edge turned away from the interior, in local
  // terms, so it holds for a concave outline too; mapped to render space.
  const turn = signedArea2(outline) > 0 ? 1 : -1;
  const sideOut = (i: number, j: number): Vec3 => {
    const a = outline[i], b = outline[j];
    const out: Vec2 = [turn * (b[1] - a[1]), -turn * (b[0] - a[0])];
    return sub(plane.localToRender([a[0] + out[0], a[1] + out[1], z0]), plane.localToRender([a[0], a[1], z0]));
  };
  const caps = triangulateOutline(outline);
  const faces: { tri: Vec3[]; out: Vec3 }[] = [
    ...caps.map(([a, b, c]) => ({ tri: [bottom[a], bottom[b], bottom[c]], out: down })),
    ...caps.map(([a, b, c]) => ({ tri: [top[a], top[b], top[c]], out: up })),
    ...outline.flatMap((_, i) => {
      const j = (i + 1) % outline.length;
      const out = sideOut(i, j);
      return [{ tri: [bottom[i], bottom[j], top[j]], out }, { tri: [bottom[i], top[j], top[i]], out }];
    }),
  ];
  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach(({ tri, out }, f) => {
    let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const outward = dot(n, out) >= 0;
    const ordered = outward ? tri : [tri[0], tri[2], tri[1]];
    if (!outward) n = [-n[0], -n[1], -n[2]];
    const len = Math.hypot(...n) || 1;
    ordered.forEach((p, i) => {
      positions.set(p, f * 9 + i * 3);
      normals.set([n[0] / len, n[1] / len, n[2] / len], f * 9 + i * 3);
    });
    indices.set([f * 3, f * 3 + 1, f * 3 + 2], f * 3);
  });
  return { expressId, positions, normals, indices, color: [...GHOST_COLOR] };
}

/**
 * One mesh out of several prisms (a curtain wall's members, a grid's axis
 * strips): the ghost then costs one draw and one channel entry however many
 * parts the layout has. Null when there is nothing to draw.
 */
export function mergeGhostMeshes(
  meshes: readonly MeshData[],
  expressId: number,
  color: [number, number, number, number],
): MeshData | null {
  if (meshes.length === 0) return null;
  const vertexCount = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  const indexCount = meshes.reduce((n, m) => n + m.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vertex = 0;
  let index = 0;
  for (const m of meshes) {
    positions.set(m.positions, vertex * 3);
    normals.set(m.normals, vertex * 3);
    for (let i = 0; i < m.indices.length; i++) indices[index + i] = m.indices[i] + vertex;
    vertex += m.positions.length / 3;
    index += m.indices.length;
  }
  return { expressId, positions, normals, indices, color };
}
