/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ghost meshes for modeling-command previews (charter #6232, WP2). Built in
 * workplane-local coordinates and mapped through the workplane, so a preview
 * sits exactly where the commit will write — on a moved, rotated or
 * georeferenced model too. Rendered on the `command` authoring overlay
 * channel (`useAuthoringOverlay.ts`), never through `geometryResult`.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from './types.js';

const GHOST_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.45];
/**
 * Command ghosts live above Space Sketch's band (0x70000000): one channel's
 * removal must never take the other's meshes, and both stay above every
 * real federated id.
 */
const COMMAND_GHOST_BASE = 0x7f000000;

export function commandGhostId(s: ViewerState, index = 0): number {
  let maxReal = 0;
  for (const m of s.models.values()) maxReal = Math.max(maxReal, (m.idOffset ?? 0) + (m.maxExpressId ?? 0));
  return Math.max(COMMAND_GHOST_BASE, maxReal + 1) + index;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A straight wall box from `a` to `b` on the plane, centred on the axis. Null when degenerate. */
export function wallGhostMesh(
  plane: Workplane,
  a: Vec2,
  b: Vec2,
  thickness: number,
  height: number,
  expressId: number,
): MeshData | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-6) || !(thickness > 0) || !(height > 0)) return null;
  const nx = (-dy / length) * (thickness / 2), ny = (dx / length) * (thickness / 2);
  const ring = (z: number): Vec3[] => ([
    [a[0] + nx, a[1] + ny, z], [b[0] + nx, b[1] + ny, z], [b[0] - nx, b[1] - ny, z], [a[0] - nx, a[1] - ny, z],
  ] as const).map((p) => plane.localToRender(p));
  const [b0, b1, b2, b3] = ring(0);
  const [t0, t1, t2, t3] = ring(height);
  const faces: Vec3[][] = [[b0, b1, b2, b3], [t0, t3, t2, t1], [b0, t0, t1, b1], [b1, t1, t2, b2], [b2, t2, t3, b3], [b3, t3, t0, b0]];
  const positions = new Float32Array(faces.length * 12);
  const normals = new Float32Array(faces.length * 12);
  const indices = new Uint32Array(faces.length * 6);
  faces.forEach((quad, f) => {
    const n = cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]));
    const len = Math.hypot(...n) || 1;
    quad.forEach((p, i) => {
      positions.set(p, f * 12 + i * 3);
      normals.set([n[0] / len, n[1] / len, n[2] / len], f * 12 + i * 3);
    });
    indices.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
  });
  return { expressId, positions, normals, indices, color: [...GHOST_COLOR] };
}
