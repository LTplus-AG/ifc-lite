/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Raycasting utilities extracted from Scene.
 *
 * Pure math — takes positions/indices/rays and returns intersection results.
 * No dependency on Scene internal state.
 */

import type { Vec3, PickClipState } from './types.js';
import { MathUtils } from './math.js';

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

/** True when `clip` actually clips anything (a section plane or an enabled box). */
export function clipIsActive(clip?: PickClipState | null): boolean {
  return !!(clip && (clip.sectionPlane || clip.clipBox?.enabled));
}

/**
 * Is world point (x,y,z) clipped away (invisible) by the section plane or crop
 * box? Mirrors the renderer's fragment discard EXACTLY so a CPU pick can't select
 * geometry the GPU cropped/sectioned off. Section: discard where
 * (dot(p,n) - distance) * side > 0; box: discard outside the AABB.
 */
export function pointClipped(clip: PickClipState | null | undefined, x: number, y: number, z: number): boolean {
  const sp = clip?.sectionPlane;
  if (sp) {
    const side = sp.flipped ? -1 : 1;
    if ((x * sp.normal[0] + y * sp.normal[1] + z * sp.normal[2] - sp.distance) * side > 0) return true;
  }
  const b = clip?.clipBox;
  if (b?.enabled) {
    if (x < b.min[0] || y < b.min[1] || z < b.min[2] || x > b.max[0] || y > b.max[1] || z > b.max[2]) return true;
  }
  return false;
}

/**
 * Is the whole AABB clipped away: every corner cut by the section plane, or no
 * overlap with the crop box? Used to skip fully-hidden entities/boxes before the
 * triangle test (perf) and to clip the bounding-box-only raycast (released geom).
 * Conservative: only skips when NOTHING of the box could be visible.
 */
export function boxFullyClipped(clip: PickClipState | null | undefined, box: BoundingBox): boolean {
  const sp = clip?.sectionPlane;
  if (sp) {
    const side = sp.flipped ? -1 : 1;
    const [nx, ny, nz] = sp.normal;
    // Corner that minimises (dot(p,n) - dist)*side: per axis pick min/max by sign.
    const px = nx * side >= 0 ? box.min.x : box.max.x;
    const py = ny * side >= 0 ? box.min.y : box.max.y;
    const pz = nz * side >= 0 ? box.min.z : box.max.z;
    if ((px * nx + py * ny + pz * nz - sp.distance) * side > 0) return true; // every corner cut
  }
  const b = clip?.clipBox;
  if (b?.enabled) {
    if (
      box.max.x < b.min[0] || box.min.x > b.max[0] ||
      box.max.y < b.min[1] || box.min.y > b.max[1] ||
      box.max.z < b.min[2] || box.min.z > b.max[2]
    ) return true; // no overlap with crop box
  }
  return false;
}

/**
 * Ray-box intersection test (slab method).
 * Handles zero ray direction components (axis-aligned rays) safely.
 */
export function rayIntersectsBox(
  rayOrigin: Vec3,
  rayDirInv: Vec3,  // 1/rayDir for efficiency
  rayDirSign: [number, number, number],
  box: BoundingBox
): boolean {
  const bounds = [box.min, box.max];

  let tmin = -Infinity;
  let tmax = Infinity;

  // X axis
  if (!isFinite(rayDirInv.x)) {
    if (rayOrigin.x < box.min.x || rayOrigin.x > box.max.x) return false;
  } else {
    tmin = (bounds[rayDirSign[0]].x - rayOrigin.x) * rayDirInv.x;
    tmax = (bounds[1 - rayDirSign[0]].x - rayOrigin.x) * rayDirInv.x;
  }

  // Y axis
  if (!isFinite(rayDirInv.y)) {
    if (rayOrigin.y < box.min.y || rayOrigin.y > box.max.y) return false;
  } else {
    const tymin = (bounds[rayDirSign[1]].y - rayOrigin.y) * rayDirInv.y;
    const tymax = (bounds[1 - rayDirSign[1]].y - rayOrigin.y) * rayDirInv.y;
    if (tmin > tymax || tymin > tmax) return false;
    if (tymin > tmin) tmin = tymin;
    if (tymax < tmax) tmax = tymax;
  }

  // Z axis
  if (!isFinite(rayDirInv.z)) {
    if (rayOrigin.z < box.min.z || rayOrigin.z > box.max.z) return false;
  } else {
    const tzmin = (bounds[rayDirSign[2]].z - rayOrigin.z) * rayDirInv.z;
    const tzmax = (bounds[1 - rayDirSign[2]].z - rayOrigin.z) * rayDirInv.z;
    if (tmin > tzmax || tzmin > tmax) return false;
    if (tzmin > tmin) tmin = tzmin;
    if (tzmax < tmax) tmax = tzmax;
  }

  return tmax >= 0;
}

/**
 * Ray-box intersection returning entry distance (tNear).
 * Returns null if no intersection, otherwise the distance along the ray
 * to the entry point (clamped to 0 if the ray originates inside the box).
 * Handles zero ray direction components (axis-aligned rays) safely.
 */
export function rayBoxDistance(
  rayOrigin: Vec3,
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  box: BoundingBox
): number | null {
  const bounds = [box.min, box.max];

  let tmin = -Infinity;
  let tmax = Infinity;

  // X axis
  if (!isFinite(rayDirInv.x)) {
    // Ray parallel to X: miss if origin outside X slab
    if (rayOrigin.x < box.min.x || rayOrigin.x > box.max.x) return null;
  } else {
    const t1 = (bounds[rayDirSign[0]].x - rayOrigin.x) * rayDirInv.x;
    const t2 = (bounds[1 - rayDirSign[0]].x - rayOrigin.x) * rayDirInv.x;
    tmin = t1;
    tmax = t2;
  }

  // Y axis
  if (!isFinite(rayDirInv.y)) {
    if (rayOrigin.y < box.min.y || rayOrigin.y > box.max.y) return null;
  } else {
    const tymin = (bounds[rayDirSign[1]].y - rayOrigin.y) * rayDirInv.y;
    const tymax = (bounds[1 - rayDirSign[1]].y - rayOrigin.y) * rayDirInv.y;
    if (tmin > tymax || tymin > tmax) return null;
    if (tymin > tmin) tmin = tymin;
    if (tymax < tmax) tmax = tymax;
  }

  // Z axis
  if (!isFinite(rayDirInv.z)) {
    if (rayOrigin.z < box.min.z || rayOrigin.z > box.max.z) return null;
  } else {
    const tzmin = (bounds[rayDirSign[2]].z - rayOrigin.z) * rayDirInv.z;
    const tzmax = (bounds[1 - rayDirSign[2]].z - rayOrigin.z) * rayDirInv.z;
    if (tmin > tzmax || tzmin > tmax) return null;
    if (tzmin > tmin) tmin = tzmin;
    if (tzmax < tmax) tmax = tzmax;
  }

  if (tmax < 0) return null;
  return tmin < 0 ? 0 : tmin;
}

/** Ray-box entry/exit params [tmin, tmax] (unclamped), or null on miss. */
function rayBoxInterval(
  rayOrigin: Vec3,
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  box: BoundingBox,
): { tmin: number; tmax: number } | null {
  const bounds = [box.min, box.max];
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: (keyof Vec3)[] = ['x', 'y', 'z'];
  for (let a = 0; a < 3; a++) {
    const ax = axes[a];
    if (!isFinite(rayDirInv[ax])) {
      if (rayOrigin[ax] < box.min[ax] || rayOrigin[ax] > box.max[ax]) return null;
    } else {
      const t1 = (bounds[rayDirSign[a]][ax] - rayOrigin[ax]) * rayDirInv[ax];
      const t2 = (bounds[1 - rayDirSign[a]][ax] - rayOrigin[ax]) * rayDirInv[ax];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
  }
  if (tmax < tmin || tmax < 0) return null;
  return { tmin, tmax };
}

/**
 * Entry distance into the VISIBLE part of `box` under the section plane / crop
 * box, or null if the box is wholly clipped along the ray. Unlike a plain box
 * entry, this clips the crop box exactly (AABB intersection) and the section
 * plane as a half-space, so the released-geometry bbox raycast can't return a box
 * whose only ray overlap is in the cropped/sectioned-away region.
 */
export function clippedBoxEntryDistance(
  rayOrigin: Vec3,
  rayDir: Vec3,
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  box: BoundingBox,
  clip: PickClipState | null | undefined,
): number | null {
  // Crop box: the visible region inside `box` is exactly box intersect cropBox (both AABB).
  let testBox = box;
  const cb = clip?.clipBox;
  if (cb?.enabled) {
    const min: Vec3 = { x: Math.max(box.min.x, cb.min[0]), y: Math.max(box.min.y, cb.min[1]), z: Math.max(box.min.z, cb.min[2]) };
    const max: Vec3 = { x: Math.min(box.max.x, cb.max[0]), y: Math.min(box.max.y, cb.max[1]), z: Math.min(box.max.z, cb.max[2]) };
    if (min.x > max.x || min.y > max.y || min.z > max.z) return null;
    testBox = { min, max };
  }
  const iv = rayBoxInterval(rayOrigin, rayDirInv, rayDirSign, testBox);
  if (!iv) return null;
  let { tmin, tmax } = iv;

  // Section plane: visible where f(t) = (dot(P(t),n) - dist) * side <= 0.
  const sp = clip?.sectionPlane;
  if (sp) {
    const side = sp.flipped ? -1 : 1;
    const [nx, ny, nz] = sp.normal;
    const f0 = (rayOrigin.x * nx + rayOrigin.y * ny + rayOrigin.z * nz - sp.distance) * side;
    const slope = (rayDir.x * nx + rayDir.y * ny + rayDir.z * nz) * side;
    if (Math.abs(slope) < 1e-12) {
      if (f0 > 0) return null; // ray runs parallel on the cut-away side
    } else {
      const tCross = -f0 / slope;
      if (slope > 0) {
        if (tmin > tCross) return null;       // whole interval cut away
        if (tmax > tCross) tmax = tCross;      // visible only up to the plane
      } else {
        if (tmax < tCross) return null;
        if (tmin < tCross) tmin = tCross;      // visible only beyond the plane
      }
    }
    if (tmax < tmin) return null;
  }
  return tmin < 0 ? 0 : tmin;
}

/**
 * Möller–Trumbore ray-triangle intersection.
 * Returns distance to intersection or null if no hit.
 */
export function rayTriangleIntersect(
  rayOrigin: Vec3,
  rayDir: Vec3,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3
): number | null {
  const EPSILON = 1e-7;

  const edge1 = MathUtils.subtract(v1, v0);
  const edge2 = MathUtils.subtract(v2, v0);
  const h = MathUtils.cross(rayDir, edge2);
  const a = MathUtils.dot(edge1, h);

  if (a > -EPSILON && a < EPSILON) return null; // Ray parallel to triangle

  const f = 1.0 / a;
  const s = MathUtils.subtract(rayOrigin, v0);
  const u = f * MathUtils.dot(s, h);

  if (u < 0.0 || u > 1.0) return null;

  const q = MathUtils.cross(s, edge1);
  const v = f * MathUtils.dot(rayDir, q);

  if (v < 0.0 || u + v > 1.0) return null;

  const t = f * MathUtils.dot(edge2, q);

  if (t > EPSILON) return t; // Ray intersection
  return null;
}

/** Result of a CPU raycast hit. */
export interface RaycastHit {
  expressId: number;
  distance: number;
  modelIndex?: number;
}

/**
 * Precompute inverse direction and sign arrays for a ray direction.
 * Shared by both the boolean and distance box tests.
 */
export function prepareRayDirInv(rayDir: Vec3): { rayDirInv: Vec3; rayDirSign: [number, number, number] } {
  const rayDirInv: Vec3 = {
    x: rayDir.x !== 0 ? 1.0 / rayDir.x : Infinity,
    y: rayDir.y !== 0 ? 1.0 / rayDir.y : Infinity,
    z: rayDir.z !== 0 ? 1.0 / rayDir.z : Infinity,
  };
  const rayDirSign: [number, number, number] = [
    rayDirInv.x < 0 ? 1 : 0,
    rayDirInv.y < 0 ? 1 : 0,
    rayDirInv.z < 0 ? 1 : 0,
  ];
  return { rayDirInv, rayDirSign };
}

/**
 * CPU raycast against bounding-box-only data (post geometry release).
 * Returns the closest hit by bounding-box entry distance.
 */
export function raycastBoundingBoxes(
  rayOrigin: Vec3,
  rayDir: Vec3,
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  boundingBoxes: Map<number, BoundingBox>,
  hiddenIds?: Set<number>,
  isolatedIds?: Set<number> | null,
  clip?: PickClipState | null,
): RaycastHit | null {
  let closestHit: RaycastHit | null = null;
  let closestDistance = Infinity;
  const hasClip = clipIsActive(clip);

  for (const [expressId, bbox] of boundingBoxes) {
    if (hiddenIds?.has(expressId)) continue;
    if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;

    // Entry into the VISIBLE part of the box, so a box clipped (fully or
    // partially) by the section plane / crop box can't win the pick.
    const tNear = hasClip
      ? clippedBoxEntryDistance(rayOrigin, rayDir, rayDirInv, rayDirSign, bbox, clip)
      : rayBoxDistance(rayOrigin, rayDirInv, rayDirSign, bbox);
    if (tNear !== null && tNear < closestDistance) {
      closestDistance = tNear;
      closestHit = { expressId, distance: tNear };
    }
  }
  return closestHit;
}

/**
 * CPU raycast against triangle mesh data with a bounding-box pre-filter.
 *
 * @param rayOrigin  - Ray origin in world space
 * @param rayDir     - Normalised ray direction
 * @param meshDataMap - Map expressId -> MeshData[] (positions, normals, indices, entityIds)
 * @param getEntityBoundingBox - Function to obtain/cache a bounding box per entity
 * @param hiddenIds  - Optional set of hidden expressIds to skip
 * @param isolatedIds - Optional set; when non-null only these expressIds are tested
 */
export function raycastTriangles(
  rayOrigin: Vec3,
  rayDir: Vec3,
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  meshDataMap: Map<number, { positions: Float32Array; indices: Uint32Array; entityIds?: Uint32Array; modelIndex?: number; origin?: [number, number, number] }[]>,
  getEntityBoundingBox: (expressId: number) => BoundingBox | null,
  hiddenIds?: Set<number>,
  isolatedIds?: Set<number> | null,
  clip?: PickClipState | null,
): RaycastHit | null {
  let closestHit: RaycastHit | null = null;
  let closestDistance = Infinity;
  const hasClip = clipIsActive(clip);

  // First pass: filter by bounding box (fast)
  const candidates: number[] = [];

  for (const expressId of meshDataMap.keys()) {
    if (hiddenIds?.has(expressId)) continue;
    if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;

    const bbox = getEntityBoundingBox(expressId);
    if (!bbox) continue;
    // Skip entities the section plane / crop box fully hides.
    if (hasClip && boxFullyClipped(clip, bbox)) continue;

    if (rayIntersectsBox(rayOrigin, rayDirInv, rayDirSign, bbox)) {
      candidates.push(expressId);
    }
  }

  // Second pass: test triangles for candidates (accurate)
  for (const expressId of candidates) {
    const pieces = meshDataMap.get(expressId);
    if (!pieces) continue;

    for (const piece of pieces) {
      const positions = piece.positions;
      const indices = piece.indices;
      const pieceEntityIds = piece.entityIds;

      // Positions are in the element's local frame (world = origin + position).
      // Rather than offset every triangle vertex, shift the ray origin into the
      // local frame once (a pure translation; rayDir + the returned distance t
      // are translation-invariant). No-op when origin is absent/[0,0,0].
      const o = piece.origin;
      const localRayOrigin: Vec3 = o
        ? { x: rayOrigin.x - o[0], y: rayOrigin.y - o[1], z: rayOrigin.z - o[2] }
        : rayOrigin;

      for (let i = 0; i < indices.length; i += 3) {
        // For color-merged meshes, skip triangles that don't belong to
        // this entity.
        if (pieceEntityIds) {
          const vertIdx = indices[i];
          if (pieceEntityIds[vertIdx] !== expressId) continue;
        }

        const i0 = indices[i] * 3;
        const i1 = indices[i + 1] * 3;
        const i2 = indices[i + 2] * 3;

        const v0: Vec3 = { x: positions[i0], y: positions[i0 + 1], z: positions[i0 + 2] };
        const v1: Vec3 = { x: positions[i1], y: positions[i1 + 1], z: positions[i1 + 2] };
        const v2: Vec3 = { x: positions[i2], y: positions[i2 + 1], z: positions[i2 + 2] };

        const t = rayTriangleIntersect(localRayOrigin, rayDir, v0, v1, v2);
        if (t !== null && t < closestDistance) {
          // Reject hits the user has sectioned/cropped away so the pick falls
          // through to the nearest VISIBLE surface behind the cut. World hit =
          // rayOrigin + t*rayDir (the local-frame origin offset cancels).
          if (hasClip && pointClipped(
            clip,
            rayOrigin.x + t * rayDir.x,
            rayOrigin.y + t * rayDir.y,
            rayOrigin.z + t * rayDir.z,
          )) continue;
          closestDistance = t;
          closestHit = { expressId, distance: t, modelIndex: piece.modelIndex };
        }
      }
    }
  }

  return closestHit;
}
