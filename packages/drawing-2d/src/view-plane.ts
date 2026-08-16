/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera-derived section plane for exporting the 3D viewport as a to-scale
 * vector PDF (issue #2042).
 *
 * # Defect class this module guards against
 * A "1:100" page that is dimensionally plausible but geometrically wrong —
 * **mirrored, skewed, or off-page**. Every one of those comes from the same
 * root cause: the drawing basis and the page transform disagreeing.
 *
 *  - **Skew / wrong scale.** `projectTo2DBasis` is a plain pair of dot
 *    products; it is a *rigid* projection only when `tangent`/`bitangent`
 *    are unit-length AND mutually orthogonal AND perpendicular to the view
 *    normal. An `up` vector taken verbatim from an orbiting camera is
 *    generally NOT perpendicular to the view direction, so using it raw
 *    stretches one screen axis: a wall measured on the print then reads
 *    (say) 0.97 m instead of 1.00 m — a defect an engineer only discovers
 *    with a ruler. The basis built here is re-orthogonalised, so
 *    `|projected(a) − projected(b)| == |a − b|` exactly for any two points
 *    lying in a plane parallel to the drawing plane.
 *  - **Mirroring** (the #2119 defect class). The basis is fixed as
 *    `cross(tangent, bitangent) === normal`, with `tangent` = screen-right
 *    and `bitangent` = screen-up, so a point to the right of the camera
 *    target lands to the right of the page centre after `worldPointToPdfMm`
 *    (which applies the paper Y flip, and only that).
 *  - **Off-page geometry.** The plane is placed strictly IN FRONT of all
 *    eight world-bounds corners along the view direction, so every point of
 *    the model has a positive view depth inside `[0, viewDepth]` — the
 *    window the depth raster and the projection bands both key off. A plane
 *    placed inside the model would silently cut away half the drawing.
 *
 * The camera is treated as an ORTHOGRAPHIC (parallel) projection along
 * `position → target`. That is the only scale-truthful reading of "print
 * what I see at 1:N": a perspective image has no single scale.
 *
 * All world coordinates are in the same metric, RTC-shifted world space as
 * `MeshData.positions` + `MeshData.origin` (WebGL Y-up, metres).
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { SectionAxis, SectionPlaneConfig, Vec3 } from './types.js';
import { vec3, vec3Cross, vec3Dot, vec3Length, vec3Normalize, vec3Sub } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** The subset of a 3D camera the parallel projection actually needs. */
export interface CameraFrame {
  /** Eye position (world, metres). */
  position: Vec3;
  /** Orbit target / look-at point (world, metres). */
  target: Vec3;
  /** Camera up hint. Need NOT be perpendicular to the view direction — it is
   *  re-orthogonalised here — but must not be the zero vector. */
  up: Vec3;
}

/** An axis-aligned world-space box (absolute world coords, metres). */
export interface WorldBounds3D {
  min: Vec3;
  max: Vec3;
}

/** A synthetic section plane standing in for the camera. */
export interface CameraSectionPlane {
  /**
   * Plane config whose `customPlane` carries the orthonormal camera basis.
   * `flipped` is always `false` and `normal = −viewDir`, so the whole model
   * sits on the KEPT (negative signed-depth) side and every point's VIEW
   * depth `−signedDepth(p, plane)` is in `(0, viewDepth)`.
   */
  plane: SectionPlaneConfig;
  /**
   * Depth of the kept window along the view direction — the model's full
   * extent plus padding on both ends. Feed it to `SectionConfig`'s
   * `projectionBelowDepth` (with a tiny `projectionAboveDepth`) so the whole
   * model projects as solid, and to the hidden-line occluder depth.
   */
  viewDepth: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORLD BOUNDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * World-space AABB of `meshes`, folding each mesh's local frame:
 * `world = origin + positions[3i..3i+3]`.
 *
 * Reading `positions` without adding `origin` is the standing local-frame
 * defect in this codebase (see `MeshData.origin`): it reports a box around
 * the model ORIGIN instead of around the model, which would place the
 * synthetic camera plane in the wrong place entirely.
 *
 * Returns `null` when no mesh contributes a vertex — the caller must decide
 * what an empty view means rather than receive an inverted/infinite box.
 */
export function worldBoundsOfMeshes(meshes: readonly MeshData[]): WorldBounds3D | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;

  for (const mesh of meshes) {
    const { positions, origin } = mesh;
    const ox = origin ? origin[0] : 0;
    const oy = origin ? origin[1] : 0;
    const oz = origin ? origin[2] : 0;
    const vertexCount = Math.floor(positions.length / 3);
    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3] + ox;
      const y = positions[i * 3 + 1] + oy;
      const z = positions[i * 3 + 2] + oz;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      any = true;
    }
  }

  if (!any) return null;
  return { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ) };
}

/** The eight corners of a world AABB, in a fixed order. */
export function worldBoundsCorners(bounds: WorldBounds3D): Vec3[] {
  const { min, max } = bounds;
  const corners: Vec3[] = [];
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        corners.push(vec3(x, y, z));
      }
    }
  }
  return corners;
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMERA PLANE
// ═══════════════════════════════════════════════════════════════════════════

/** Smallest cross-product length treated as "up is parallel to the view". */
const PARALLEL_EPSILON = 1e-6;

/**
 * A reference up that is guaranteed not to be parallel to `viewDir`: world
 * +Y unless the camera looks (near-)straight up or down, in which case world
 * +Z. Without this, a top-down / bottom-up view — the single most common
 * plan-drawing camera — produces a zero-length right vector and a basis full
 * of NaN, i.e. a blank PDF.
 */
function fallbackUp(viewDir: Vec3): Vec3 {
  return Math.abs(viewDir.y) < 0.9 ? vec3(0, 1, 0) : vec3(0, 0, 1);
}

/**
 * Build the synthetic section plane that represents the current camera view.
 *
 * @param camera World-space eye/target/up.
 * @param worldBounds World AABB of everything that will be drawn (see
 *        {@link worldBoundsOfMeshes}).
 *
 * @throws when the camera degenerates (eye == target) or the bounds are
 *         non-finite — both would otherwise yield a NaN transform and a
 *         blank-but-plausible PDF page.
 */
export function buildCameraSectionPlane(
  camera: CameraFrame,
  worldBounds: WorldBounds3D,
): CameraSectionPlane {
  const rawView = vec3Sub(camera.target, camera.position);
  if (vec3Length(rawView) < PARALLEL_EPSILON) {
    throw new Error(
      'Cannot build a camera section plane: the camera position and target coincide, ' +
        'so the view direction is undefined.',
    );
  }
  const viewDir = vec3Normalize(rawView);

  for (const v of [worldBounds.min, worldBounds.max]) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      throw new Error('Cannot build a camera section plane: world bounds must be finite.');
    }
  }

  // ── Orthonormal basis ───────────────────────────────────────────────────
  // tangent   = screen right
  // bitangent = screen up, RE-ORTHOGONALISED against the view direction
  // normal    = −viewDir (points back at the viewer)
  //
  // `cross(tangent, bitangent) === normal` holds by construction, which is
  // what keeps the page from coming out mirrored (#2119 defect class).
  const upHint = vec3Length(camera.up) < PARALLEL_EPSILON ? fallbackUp(viewDir) : camera.up;
  let right = vec3Cross(viewDir, upHint);
  if (vec3Length(right) < PARALLEL_EPSILON) {
    right = vec3Cross(viewDir, fallbackUp(viewDir));
  }
  const tangent = vec3Normalize(right);
  const bitangent = vec3Normalize(vec3Cross(tangent, viewDir));
  const normal = vec3(-viewDir.x, -viewDir.y, -viewDir.z);

  // ── Plane placement: strictly in front of every bounds corner ───────────
  // `s = dot(corner, viewDir)` grows AWAY from the viewer, so the nearest
  // corner is at `sMin`. Putting the plane a pad before `sMin` guarantees
  // every corner has a strictly positive view depth.
  const corners = worldBoundsCorners(worldBounds);
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const c of corners) {
    const s = vec3Dot(c, viewDir);
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const span = sMax - sMin;
  // Relative pad so it stays meaningful from a door handle to a city block,
  // with an absolute floor for a degenerate (flat) box.
  const pad = Math.max(span * 1e-3, 1e-4);
  const planeS = sMin - pad;

  // A genuine point ON the plane, used as the 2D basis origin so drawing
  // coordinates stay centred on the model instead of on the world origin.
  const center = vec3(
    (worldBounds.min.x + worldBounds.max.x) / 2,
    (worldBounds.min.y + worldBounds.max.y) / 2,
    (worldBounds.min.z + worldBounds.max.z) / 2,
  );
  const shift = planeS - vec3Dot(center, viewDir);
  const origin = vec3(
    center.x + viewDir.x * shift,
    center.y + viewDir.y * shift,
    center.z + viewDir.z * shift,
  );

  // dot(origin, normal) = −dot(origin, viewDir) = −planeS, computed in closed
  // form rather than re-derived from `origin` so the offset carries no extra
  // rounding from the point reconstruction above.
  const distance = -planeS;

  // Legacy cardinal fields. Every plane-aware helper (`signedDepth`,
  // `projectPointForPlane`, `SectionCutter`, the depth raster) checks
  // `customPlane` FIRST, so these only feed code that predates arbitrary
  // planes. They are set to the closest cardinal reading of this plane
  // rather than to a lie like `position: 0`.
  const axis = dominantAxis(normal);
  const position = origin[axis];

  return {
    plane: {
      axis,
      position,
      flipped: false,
      customPlane: { normal, distance, origin, tangent, bitangent },
    },
    viewDepth: span + pad * 2,
  };
}

/** The cardinal axis the plane normal is most aligned with. */
function dominantAxis(normal: Vec3): SectionAxis {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (ax >= ay && ax >= az) return 'x';
  if (ay >= az) return 'y';
  return 'z';
}
