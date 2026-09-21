/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure f64 geometry for the section-preview quad. */

import { planeBasis } from './section-plane-basis.js';

export type SectionPlaneAxis = 'down' | 'front' | 'side';

export interface SectionPlaneBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Build the cardinal section-preview quad in source f64 coordinates.
 *
 * The caller subtracts its drawable anchor before it uploads f32 vertices.
 * Keeping this array f64 is essential: an absolute 5,000 km source coordinate
 * has no f32 representation for a centimetre-scale plane displacement.
 */
export function calculateSectionPlaneVertices(
  axis: SectionPlaneAxis,
  position: number,
  bounds: SectionPlaneBounds,
  minOverride?: number,
  maxOverride?: number,
): Float64Array {
  const { min, max } = bounds;
  const scale = 1.1;
  const sizeX = (max.x - min.x) * scale;
  const sizeY = (max.y - min.y) * scale;
  const sizeZ = (max.z - min.z) * scale;
  const centerX = (min.x + max.x) / 2;
  const centerY = (min.y + max.y) / 2;
  const centerZ = (min.z + max.z) / 2;
  const t = position / 100;
  const axisName = axis === 'side' ? 'x' : axis === 'down' ? 'y' : 'z';
  const axisMin = minOverride ?? min[axisName];
  const axisMax = maxOverride ?? max[axisName];

  if (axis === 'side') {
    const x = axisMin + t * (axisMax - axisMin);
    const halfY = sizeY / 2;
    const halfZ = sizeZ / 2;
    return new Float64Array([
      x, centerY - halfY, centerZ - halfZ, 0, 0,
      x, centerY + halfY, centerZ - halfZ, 1, 0,
      x, centerY + halfY, centerZ + halfZ, 1, 1,
      x, centerY - halfY, centerZ - halfZ, 0, 0,
      x, centerY + halfY, centerZ + halfZ, 1, 1,
      x, centerY - halfY, centerZ + halfZ, 0, 1,
    ]);
  }
  if (axis === 'down') {
    const y = axisMin + t * (axisMax - axisMin);
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;
    return new Float64Array([
      centerX - halfX, y, centerZ - halfZ, 0, 0,
      centerX + halfX, y, centerZ - halfZ, 1, 0,
      centerX + halfX, y, centerZ + halfZ, 1, 1,
      centerX - halfX, y, centerZ - halfZ, 0, 0,
      centerX + halfX, y, centerZ + halfZ, 1, 1,
      centerX - halfX, y, centerZ + halfZ, 0, 1,
    ]);
  }

  const z = axisMin + t * (axisMax - axisMin);
  const halfX = sizeX / 2;
  const halfY = sizeY / 2;
  return new Float64Array([
    centerX - halfX, centerY - halfY, z, 0, 0,
    centerX + halfX, centerY - halfY, z, 1, 0,
    centerX + halfX, centerY + halfY, z, 1, 1,
    centerX - halfX, centerY - halfY, z, 0, 0,
    centerX + halfX, centerY + halfY, z, 1, 1,
    centerX - halfX, centerY + halfY, z, 0, 1,
  ]);
}

/** Build a six-vertex preview quad for the f64 plane `dot(p, normal) = distance`. */
export function calculateSectionPlaneVerticesFromNormal(
  normal: [number, number, number],
  distance: number,
  bounds: SectionPlaneBounds,
): Float64Array {
  let [nx, ny, nz] = normal;
  const length = Math.hypot(nx, ny, nz);
  if (!(length >= 1e-6 && length < Infinity)) return new Float64Array(30);
  nx /= length; ny /= length; nz /= length;
  const d = distance / length;
  const { min, max } = bounds;
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  const cz = (min.z + max.z) / 2;
  const scale = d - (cx * nx + cy * ny + cz * nz);
  const px = cx + nx * scale;
  const py = cy + ny * scale;
  const pz = cz + nz * scale;
  const { tangent, bitangent } = planeBasis([nx, ny, nz]);
  const half = 0.55 * Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
  const p0 = [px - tangent[0] * half - bitangent[0] * half, py - tangent[1] * half - bitangent[1] * half, pz - tangent[2] * half - bitangent[2] * half];
  const p1 = [px + tangent[0] * half - bitangent[0] * half, py + tangent[1] * half - bitangent[1] * half, pz + tangent[2] * half - bitangent[2] * half];
  const p2 = [px + tangent[0] * half + bitangent[0] * half, py + tangent[1] * half + bitangent[1] * half, pz + tangent[2] * half + bitangent[2] * half];
  const p3 = [px - tangent[0] * half + bitangent[0] * half, py - tangent[1] * half + bitangent[1] * half, pz - tangent[2] * half + bitangent[2] * half];
  return new Float64Array([
    ...p0, 0, 0, ...p1, 1, 0, ...p2, 1, 1,
    ...p0, 0, 0, ...p2, 1, 1, ...p3, 0, 1,
  ]);
}
