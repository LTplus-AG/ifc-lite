/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounds helpers for `useGeometryStreaming`'s camera fit (moved out of the hook). */

import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { NORMAL_COORD_THRESHOLD_M } from '@ifc-lite/geometry';

// The per-vertex corruption filter `computeBounds` applies before fitting the
// camera. Shared with `CoordinateHandler`, `localParsingUtils` and
// `viewportUtils` — see `NORMAL_COORD_THRESHOLD_M`.
const MAX_VALID_COORD = NORMAL_COORD_THRESHOLD_M;

export type Bounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

export function computeBounds(meshes: MeshData[]): Bounds | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let gi = 0; gi < meshes.length; gi++) {
    const positions = meshes[gi].positions;
    // world = origin + position (per-element local frame); without folding the
    // origin every element's local positions cluster near 0, so the camera fits
    // to the origin while geometry draws at its true world coords → blank view.
    const o = meshes[gi].origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
      if (Math.abs(x) < MAX_VALID_COORD && Math.abs(y) < MAX_VALID_COORD && Math.abs(z) < MAX_VALID_COORD) {
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      }
    }
  }
  const maxSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (minX === Infinity || maxSize <= 0 || !Number.isFinite(maxSize)) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

export function userMovedCamera(
  renderer: Renderer,
  snapshot: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null,
): boolean {
  if (!snapshot) return false;
  const pos = renderer.getCamera().getPosition();
  const tgt = renderer.getCamera().getTarget();
  const EPS = 0.5;
  return (
    Math.abs(pos.x - snapshot.px) > EPS || Math.abs(pos.y - snapshot.py) > EPS || Math.abs(pos.z - snapshot.pz) > EPS ||
    Math.abs(tgt.x - snapshot.tx) > EPS || Math.abs(tgt.y - snapshot.ty) > EPS || Math.abs(tgt.z - snapshot.tz) > EPS
  );
}
