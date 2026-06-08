/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ProfileProjector — Clean 2D projection from WASM-extracted profile polygons.
 *
 * Replaces `EdgeExtractor` for projection lines of extruded-area solids,
 * eliminating tessellation artifacts caused by drawing every internal mesh
 * triangle edge.
 *
 * # Algorithm
 * For each `ProfileEntry` (from `IfcAPI.extractProfiles()`):
 *  1. Determine the element's bounding range along the section axis.
 *  2. Classify it into a projection band (issue #979):
 *       - below the cut → VISIBLE  (thin solid)
 *       - above the cut → OVERHEAD (dashed; emitted as `visibility:'hidden'`)
 *       - straddling    → drawn solid
 *       - outside both bands → dropped
 *  3. Transform the profile boundary points to world space and project each
 *     boundary edge onto the drawing plane, emitting `DrawingLine[]` with
 *     `category: 'projection'` and the band's visibility.
 *
 * # Coordinates
 * All geometry (profile points, transform, extrusionDir) is in **WebGL Y-up**
 * world space (metres), consistent with `MeshData.positions`. Projection uses
 * the SAME basis as the section cutter (`projectPointForPlane`) so projected
 * lines coincide with cut polygons.
 */

import type { ProfileEntry, SectionPlaneConfig, DrawingLine, LineCategory, Vec3 } from './types.js';
import {
  type ProjectionBand,
  type ProjectionBandDepths,
  classifyDepthRange,
  bandVisibility,
  projectPointForPlane,
  signedDepth,
} from './projection-bands.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project profile polygons into 2D drawing lines, classified into the
 * construction-projection bands.
 *
 * @param profiles  Profiles from `IfcAPI.extractProfiles()`.
 * @param plane     Section plane (axis + position, or custom).
 * @param depths    Below/above projection-band depths (world units, both > 0).
 * @returns         `DrawingLine[]` with `category: 'projection'`; overhead
 *                  lines carry `visibility: 'hidden'` (dashed downstream).
 */
export function projectProfiles(
  profiles: ProfileEntry[],
  plane: SectionPlaneConfig,
  depths: ProjectionBandDepths,
): DrawingLine[] {
  const lines: DrawingLine[] = [];

  for (const profile of profiles) {
    const band = classifyProfileBand(profile, plane, depths);
    const visibility = bandVisibility(band);
    if (visibility === null) {
      continue; // outside both bands
    }

    // Project outer boundary
    pushContourLines(lines, profile, profile.outerPoints, 'projection', plane, visibility);

    // Project holes
    let offset = 0;
    for (let h = 0; h < profile.holeCounts.length; h++) {
      const count = profile.holeCounts[h];
      if (count < 2 || offset + count * 2 > profile.holePoints.length) {
        offset += count * 2;
        continue;
      }
      const holeSlice = profile.holePoints.subarray(offset, offset + count * 2);
      pushContourLines(lines, profile, holeSlice, 'projection', plane, visibility);
      offset += count * 2;
    }
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify a profile's extruded volume into a projection band by its
 * flip-adjusted axis range. For a custom plane the depth is measured against
 * the plane normal; for cardinal axes against the canonical +axis.
 */
function classifyProfileBand(
  profile: ProfileEntry,
  plane: SectionPlaneConfig,
  depths: ProjectionBandDepths,
): ProjectionBand {
  const { min, max } = getProfileDepthRange(profile, plane);
  return classifyDepthRange(min, max, depths);
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
  visibility: 'visible' | 'hidden',
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

    const p0 = projectPointForPlane(w0, plane);
    const p1 = projectPointForPlane(w1, plane);

    // Skip degenerate (zero-length) segments
    if (Math.abs(p0.x - p1.x) < 1e-7 && Math.abs(p0.y - p1.y) < 1e-7) {
      continue;
    }

    out.push({
      line: { start: p0, end: p1 },
      category,
      visibility,
      entityId: profile.expressId,
      ifcType: profile.ifcType,
      modelIndex: profile.modelIndex,
      depth: depthAlong(w0, w1, plane),
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

/**
 * Flip-adjusted depth range of a profile's extruded volume relative to the
 * cut plane. Returns `{ min, max }` where `min < 0` means below the cut.
 *
 * For a cardinal axis this is `coord - position` along that axis; for a custom
 * plane it is the signed distance to the plane. The flip sign is applied so
 * the result is in the same convention as {@link classifyDepthRange}.
 */
function getProfileDepthRange(
  profile: ProfileEntry,
  plane: SectionPlaneConfig,
): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const consider = (point: Vec3) => {
    const d = signedDepth(point, plane);
    if (d < min) min = d;
    if (d > max) max = d;
  };

  const extrusion: Vec3 = {
    x: profile.extrusionDir[0] * profile.extrusionDepth,
    y: profile.extrusionDir[1] * profile.extrusionDepth,
    z: profile.extrusionDir[2] * profile.extrusionDepth,
  };

  const updateRange = (points2d: Float32Array) => {
    const count = Math.floor(points2d.length / 2);
    for (let index = 0; index < count; index++) {
      const base = transformPoint2D(points2d[index * 2], points2d[index * 2 + 1], profile.transform);
      consider(base);
      consider({ x: base.x + extrusion.x, y: base.y + extrusion.y, z: base.z + extrusion.z });
    }
  };

  updateRange(profile.outerPoints);
  updateRange(profile.holePoints);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    // Degenerate profile: fall back to the placement translation.
    const t: Vec3 = {
      x: matTranslation(profile.transform, 'x'),
      y: matTranslation(profile.transform, 'y'),
      z: matTranslation(profile.transform, 'z'),
    };
    const base = signedDepth(t, plane);
    const top = signedDepth(
      { x: t.x + extrusion.x, y: t.y + extrusion.y, z: t.z + extrusion.z },
      plane,
    );
    return { min: Math.min(base, top), max: Math.max(base, top) };
  }

  return { min, max };
}


function axisIndex(axis: 'x' | 'y' | 'z'): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

/**
 * Average flip-adjusted depth of a projected edge along the viewing direction.
 * Smaller depth means nearer the viewer, matching the depth-buffer convention
 * in HiddenLineClassifier.
 */
function depthAlong(w0: Vec3, w1: Vec3, plane: SectionPlaneConfig): number {
  return (signedDepth(w0, plane) + signedDepth(w1, plane)) / 2;
}
