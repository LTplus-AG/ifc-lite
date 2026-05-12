/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Raycasting utilities extracted from Scene.
 *
 * Pure math — takes positions/indices/rays and returns intersection results.
 * No dependency on Scene internal state.
 */

import type { Vec3 } from './types.js';
import { MathUtils } from './math.js';

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
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
  rayDirInv: Vec3,
  rayDirSign: [number, number, number],
  boundingBoxes: Map<number, BoundingBox>,
  hiddenIds?: Set<number>,
  isolatedIds?: Set<number> | null,
): RaycastHit | null {
  let closestHit: RaycastHit | null = null;
  let closestDistance = Infinity;

  for (const [expressId, bbox] of boundingBoxes) {
    if (hiddenIds?.has(expressId)) continue;
    if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;

    const tNear = rayBoxDistance(rayOrigin, rayDirInv, rayDirSign, bbox);
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
  meshDataMap: Map<number, { positions: Float32Array; indices: Uint32Array; entityIds?: Uint32Array; modelIndex?: number }[]>,
  getEntityBoundingBox: (expressId: number) => BoundingBox | null,
  hiddenIds?: Set<number>,
  isolatedIds?: Set<number> | null,
): RaycastHit | null {
  let closestHit: RaycastHit | null = null;
  let closestDistance = Infinity;

  // First pass: filter by bounding box (fast)
  const candidates: number[] = [];

  for (const expressId of meshDataMap.keys()) {
    if (hiddenIds?.has(expressId)) continue;
    if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;

    const bbox = getEntityBoundingBox(expressId);
    if (!bbox) continue;

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

        const t = rayTriangleIntersect(rayOrigin, rayDir, v0, v1, v2);
        if (t !== null && t < closestDistance) {
          closestDistance = t;
          closestHit = { expressId, distance: t, modelIndex: piece.modelIndex };
        }
      }
    }
  }

  return closestHit;
}
