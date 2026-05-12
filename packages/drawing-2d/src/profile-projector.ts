/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ProfileProjector — Clean 2D projection from WASM-extracted profile polygons.
 *
 * Replaces `EdgeExtractor` for projection lines, eliminating tessellation
 * artifacts caused by drawing every internal mesh triangle edge.
 *
 * # Algorithm
 * For each `ProfileEntry` (from `IfcAPI.extractProfiles()`):
 *  1. Determine the element's bounding range along the section axis.
 *  2. If it falls within the projection window, transform the profile boundary
 *     points to world space (applying the 4×4 column-major transform).
 *  3. Project each boundary edge onto the drawing plane and emit `DrawingLine[]`
 *     with `category: 'projection'`.
 *
 * # Coordinates
 * All geometry (profile points, transform, extrusionDir) is in **WebGL Y-up**
 * world space (metres), consistent with `MeshData.positions`.
 */

import type { ProfileEntry, SectionPlaneConfig, DrawingLine, LineCategory, Vec3 } from './types.js';
import { projectTo2D } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project profile polygons into 2D drawing lines.
 *
 * @param profiles    Profiles from `IfcAPI.extractProfiles()`.
 * @param plane       Section plane (axis + position).
 * @param viewDepth   Depth window beyond the cut plane (metres).  Elements
 *                    whose bounding range along the section axis falls within
 *                    `[sectionPos, sectionPos + viewDepth]` (or the flipped
 *                    equivalent) are projected.
 * @returns           `DrawingLine[]` with `category: 'projection'`.
 */
export function projectProfiles(
  profiles: ProfileEntry[],
  plane: SectionPlaneConfig,
  viewDepth: number,
): DrawingLine[] {
  const lines: DrawingLine[] = [];

  for (const profile of profiles) {
    if (!isInProjectionRange(profile, plane, viewDepth)) {
      continue;
    }

    // Project outer boundary
    pushContourLines(lines, profile, profile.outerPoints, 'projection', plane);

    // Project holes
    let offset = 0;
    for (let h = 0; h < profile.holeCounts.length; h++) {
      const count = profile.holeCounts[h];
      if (count < 2 || offset + count * 2 > profile.holePoints.length) {
        offset += count * 2;
        continue;
      }
      const holeSlice = profile.holePoints.subarray(offset, offset + count * 2);
      pushContourLines(lines, profile, holeSlice, 'projection', plane);
      offset += count * 2;
    }
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check whether a profile's extruded volume intersects the projection window.
 *
 * For section `axis = 'y'` (plan view up/down):
 * - Not flipped: window is `[sectionPos, sectionPos + viewDepth]`  (above cut)
 * - Flipped:     window is `[sectionPos - viewDepth, sectionPos]`  (below cut)
 *
 * The element's range along the axis is `[baseCoord, topCoord]` where
 * `topCoord = baseCoord + extrusionDir[axis] * extrusionDepth`.
 */
function isInProjectionRange(
  profile: ProfileEntry,
  plane: SectionPlaneConfig,
  viewDepth: number,
): boolean {
  const { axis, position: sectionPos, flipped } = plane;
  const { min, max } = getProfileAxisRange(profile, axis);

  // Projection window (elements on the "far" side of the cut plane)
  const rangeMin = flipped ? sectionPos - viewDepth : sectionPos;
  const rangeMax = flipped ? sectionPos : sectionPos + viewDepth;

  // Overlap test: [lo, hi] ∩ [rangeMin, rangeMax] ≠ ∅
  return min <= rangeMax && max >= rangeMin;
}

/**
 * Convert a flat `[x0, y0, x1, y1, …]` contour in local profile space into
 * `DrawingLine[]` by applying the profile transform and projecting to 2D.
 */
function pushContourLines(
  out: DrawingLine[],
  profile: ProfileEntry,
  points2d: Float32Array,
  category: LineCategory,
  plane: SectionPlaneConfig,
): void {
  const n = Math.floor(points2d.length / 2);
  if (n < 2) return;

  const m = profile.transform;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;

    const x0 = points2d[i * 2];
    const y0 = points2d[i * 2 + 1];
    const x1 = points2d[j * 2];
    const y1 = points2d[j * 2 + 1];

    const w0 = transformPoint2D(x0, y0, m);
    const w1 = transformPoint2D(x1, y1, m);

    const p0 = projectTo2D(w0, plane.axis, plane.flipped);
    const p1 = projectTo2D(w1, plane.axis, plane.flipped);

    // Skip degenerate (zero-length) segments
    if (Math.abs(p0.x - p1.x) < 1e-7 && Math.abs(p0.y - p1.y) < 1e-7) {
      continue;
    }

    out.push({
      line: { start: p0, end: p1 },
      category,
      visibility: 'visible',
      entityId: profile.expressId,
      ifcType: profile.ifcType,
      modelIndex: profile.modelIndex,
      depth: depthAlong(w0, w1, plane.axis, plane.position),
    });
  }
}

/**
 * Apply a 4×4 column-major transform to a 2D profile point [x, y, 0, 1].
 *
 * Column-major layout (index = col * 4 + row):
 *  wx = m[0]*x + m[4]*y + m[12]
 *  wy = m[1]*x + m[5]*y + m[13]
 *  wz = m[2]*x + m[6]*y + m[14]
 */
function transformPoint2D(x: number, y: number, m: Float32Array): Vec3 {
  return {
    x: m[0] * x + m[4] * y + m[12],
    y: m[1] * x + m[5] * y + m[13],
    z: m[2] * x + m[6] * y + m[14],
  };
}

/** Extract the translation component along `axis` from a column-major matrix. */
function matTranslation(m: Float32Array, axis: 'x' | 'y' | 'z'): number {
  // Translation is in column 3 (indices 12, 13, 14 for x, y, z)
  return m[12 + axisIndex(axis)];
}

function getProfileAxisRange(
  profile: ProfileEntry,
  axis: 'x' | 'y' | 'z',
): { min: number; max: number } {
  const axisName = axis;
  const extrusionDelta = profile.extrusionDir[axisIndex(axis)] * profile.extrusionDepth;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const updateRange = (points2d: Float32Array) => {
    const count = Math.floor(points2d.length / 2);
    for (let index = 0; index < count; index++) {
      const point = transformPoint2D(points2d[index * 2], points2d[index * 2 + 1], profile.transform);
      const base = point[axisName];
      const top = base + extrusionDelta;
      min = Math.min(min, base, top);
      max = Math.max(max, base, top);
    }
  };

  updateRange(profile.outerPoints);
  updateRange(profile.holePoints);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const base = matTranslation(profile.transform, axis);
    const top = base + extrusionDelta;
    return { min: Math.min(base, top), max: Math.max(base, top) };
  }

  return { min, max };
}

function axisIndex(axis: 'x' | 'y' | 'z'): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

/** Average depth of a projected edge (distance from section plane, for sorting). */
function depthAlong(
  w0: Vec3,
  w1: Vec3,
  axis: 'x' | 'y' | 'z',
  sectionPos: number,
): number {
  const avg = (w0[axis] + w1[axis]) / 2;
  return Math.abs(avg - sectionPos);
}
