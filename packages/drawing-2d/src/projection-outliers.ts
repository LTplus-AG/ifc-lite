/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dropping artifact projection lines — lines abnormally longer than the
 * drawing they belong to (a stray vertex, a degenerate triangle).
 *
 * The reference extent is the cut area UNIONED with the meshes' own
 * footprint on the drawing plane. Measuring against the cut area alone
 * (the original rule) breaks any view whose plane cuts little or nothing —
 * an elevation just inside the model bounds cuts a few railings, so every
 * real facade line longer than 1.5 × those railings' extent was dropped and
 * the elevation drew as scattered fragments. The meshes' footprint is the
 * honest bound: no real projected edge can be longer than the projected
 * model it comes from.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds2D, DrawingLine, SectionPlaneConfig } from './types.js';
import { getProjectionAxes, lineLength } from './math.js';

/** Lines up to this multiple of the reference diagonal are kept. */
export const OUTLIER_LINE_FACTOR = 1.5;

/** The meshes' bounding box in drawing (u, v) coordinates for `plane`. */
export function projectedMeshBounds(meshes: readonly MeshData[], plane: SectionPlaneConfig): Bounds2D {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const custom = plane.customPlane;
  const axes = getProjectionAxes(plane.axis);
  const ui = axes.u === 'x' ? 0 : axes.u === 'y' ? 1 : 2;
  const vi = axes.v === 'x' ? 0 : axes.v === 'y' ? 1 : 2;
  const uSign = plane.flipped ? -1 : 1;
  for (const mesh of meshes) {
    // Positions are in the element's local frame; world = origin + local.
    const p = mesh.positions;
    const o = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i + 2 < p.length; i += 3) {
      let x: number, y: number;
      if (custom) {
        const dx = p[i] + o[0] - custom.origin.x, dy = p[i + 1] + o[1] - custom.origin.y, dz = p[i + 2] + o[2] - custom.origin.z;
        x = dx * custom.tangent.x + dy * custom.tangent.y + dz * custom.tangent.z;
        y = dx * custom.bitangent.x + dy * custom.bitangent.y + dz * custom.bitangent.z;
      } else {
        x = uSign * (p[i + ui] + o[ui]);
        y = p[i + vi] + o[vi];
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function diagonal(b: Bounds2D): number {
  if (!(b.min.x <= b.max.x && b.min.y <= b.max.y)) return 0;
  return Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y);
}

/**
 * Keep the lines no longer than {@link OUTLIER_LINE_FACTOR} × the larger of
 * the cut area's and the projected meshes' diagonals. With neither extent
 * known (nothing cut, no meshes) every line is kept.
 */
export function dropOutlierProjectionLines(
  lines: DrawingLine[],
  cutBounds: Bounds2D,
  meshes: readonly MeshData[],
  plane: SectionPlaneConfig,
): DrawingLine[] {
  const reference = Math.max(diagonal(cutBounds), diagonal(projectedMeshBounds(meshes, plane)));
  if (reference <= 0) return lines;
  const maxLength = reference * OUTLIER_LINE_FACTOR;
  return lines.filter((line) => lineLength(line.line) <= maxLength);
}
