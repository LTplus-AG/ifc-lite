/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, Mesh, Vec3 } from "./types.js";
import { cross3, length3, sub3 } from "./vec3.js";

/** Triangle as three world-space vertices. */
export interface Triangle {
  readonly v0: Vec3;
  readonly v1: Vec3;
  readonly v2: Vec3;
}

/** Read the `triIndex`-th triangle from a mesh. */
export function triangleAt(mesh: Mesh, triIndex: number): Triangle {
  const base = triIndex * 3;
  const i0 = mesh.indices[base] as number;
  const i1 = mesh.indices[base + 1] as number;
  const i2 = mesh.indices[base + 2] as number;
  return {
    v0: readVertex(mesh.positions, i0),
    v1: readVertex(mesh.positions, i1),
    v2: readVertex(mesh.positions, i2),
  };
}

function readVertex(positions: ArrayLike<number>, index: number): Vec3 {
  const b = index * 3;
  return [positions[b] as number, positions[b + 1] as number, positions[b + 2] as number];
}

/** Total triangle count in a mesh. */
export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

/** Unnormalised triangle normal = (v1-v0) × (v2-v0). Useful as a plane direction. */
export function triangleNormalRaw(t: Triangle): Vec3 {
  return cross3(sub3(t.v1, t.v0), sub3(t.v2, t.v0));
}

/** Triangle area (geometric). */
export function triangleArea(t: Triangle): number {
  return length3(triangleNormalRaw(t)) / 2;
}

/** Triangle centroid. */
export function triangleCentroid(t: Triangle): Vec3 {
  return [
    (t.v0[0] + t.v1[0] + t.v2[0]) / 3,
    (t.v0[1] + t.v1[1] + t.v2[1]) / 3,
    (t.v0[2] + t.v1[2] + t.v2[2]) / 3,
  ];
}

/** Tight AABB of a triangle. */
export function triangleAabb(t: Triangle): AABB {
  return {
    min: [
      Math.min(t.v0[0], t.v1[0], t.v2[0]),
      Math.min(t.v0[1], t.v1[1], t.v2[1]),
      Math.min(t.v0[2], t.v1[2], t.v2[2]),
    ],
    max: [
      Math.max(t.v0[0], t.v1[0], t.v2[0]),
      Math.max(t.v0[1], t.v1[1], t.v2[1]),
      Math.max(t.v0[2], t.v1[2], t.v2[2]),
    ],
  };
}

/** True when the triangle is degenerate (zero area within tolerance). */
export function isDegenerate(t: Triangle, eps = 1e-12): boolean {
  return length3(triangleNormalRaw(t)) <= eps;
}
