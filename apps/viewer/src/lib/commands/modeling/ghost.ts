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
import type { Workplane } from './types.js';
import { prismGhostMesh, segmentOutline } from './ghost-shapes.js';

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

/** A straight wall box from `a` to `b` on the plane, centred on the axis. Null when degenerate. */
export function wallGhostMesh(
  plane: Workplane,
  a: Vec2,
  b: Vec2,
  thickness: number,
  height: number,
  expressId: number,
): MeshData | null {
  return prismGhostMesh(plane, segmentOutline(a, b, thickness), 0, height, expressId);
}
