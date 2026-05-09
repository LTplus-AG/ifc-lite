/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU-side raycasting against a quantised + instanced scene.
 *
 * Keeps a JS-owned mirror of the vertex/index buffers so triangle tests can
 * dequantise positions on demand without round-tripping the GPU. Per-instance
 * world AABBs are computed once and cached; the broad-phase is a linear AABB
 * scan (good enough for most IFC federations — 10–100 k instances). A BVH
 * upgrade fits cleanly behind this same API when needed.
 *
 * Returns the same {@link Intersection} shape as the legacy {@link Raycaster}
 * so {@link RaycastEngine} can swap implementations transparently.
 */

import type { QuantizedSceneSource, QuantizedSceneBuffers, MeshDrawInfo } from './quantized-scene-buffers.js';
import { QUANTIZED_VERTEX_STRIDE } from './quantized-pipeline.js';
import type { Intersection, Ray } from './raycaster.js';
import type { MeshData } from '@ifc-lite/geometry';

const EPSILON = 1e-7;
const U16_RECIP = 1 / 65535;

/**
 * Raycaster for a single quantised scene. Constructed once per scene load
 * and reused for every ray cast.
 */
export class QuantizedRaycaster {
  private readonly buffers: QuantizedSceneBuffers;
  private readonly vertexData: Uint8Array;
  private readonly indexData: Uint32Array;
  private readonly drawInfos: readonly MeshDrawInfo[];
  /** Per-instance world AABB: 6 floats per instance (minX,minY,minZ,maxX,maxY,maxZ). */
  private worldAabbs: Float32Array | null = null;
  /** Map from instance index → mesh index, built alongside `worldAabbs`. */
  private instanceToMesh: Uint32Array | null = null;

  constructor(buffers: QuantizedSceneBuffers, source: QuantizedSceneSource) {
    this.buffers = buffers;
    // Keep references to the CPU snapshot — already independent of WASM memory.
    this.vertexData = source.vertexData;
    this.indexData = source.indexData;
    this.drawInfos = buffers.iterDrawInfos();
    if (source.instanceCount !== buffers.instanceCount) {
      throw new Error(
        `[quantized-raycast] snapshot/buffer instance count mismatch: ${source.instanceCount} vs ${buffers.instanceCount}`,
      );
    }
  }

  /**
   * Cast a ray into the scene. Returns the closest hit's {@link Intersection}
   * (in world space) or `null` if nothing was hit.
   */
  raycast(ray: Ray): Intersection | null {
    if (this.buffers.instanceCount === 0) return null;
    this.ensureWorldAabbs();
    const aabbs = this.worldAabbs!;
    const i2m = this.instanceToMesh!;

    const dirX = ray.direction.x;
    const dirY = ray.direction.y;
    const dirZ = ray.direction.z;
    const invDx = dirX !== 0 ? 1 / dirX : Infinity;
    const invDy = dirY !== 0 ? 1 / dirY : Infinity;
    const invDz = dirZ !== 0 ? 1 / dirZ : Infinity;
    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;

    let best: Intersection | null = null;
    let bestT = Infinity;

    const instanceCount = this.buffers.instanceCount;
    for (let inst = 0; inst < instanceCount; inst++) {
      const a = inst * 6;
      // Slab test against world AABB. Reject early — also reject when the
      // closest bbox hit is farther than our current best triangle hit.
      const tEnter = rayAabb(
        ox, oy, oz,
        invDx, invDy, invDz,
        aabbs[a]!, aabbs[a + 1]!, aabbs[a + 2]!,
        aabbs[a + 3]!, aabbs[a + 4]!, aabbs[a + 5]!,
      );
      if (tEnter === null || tEnter >= bestT) continue;

      const meshIndex = i2m[inst]!;
      const hit = this.intersectInstance(ray, inst, meshIndex, bestT);
      if (hit && hit.distance < bestT) {
        bestT = hit.distance;
        best = hit;
      }
    }
    return best;
  }

  /**
   * Compute per-instance world AABBs lazily on first raycast. Each instance's
   * AABB is the world-space envelope of its mesh-local AABB after applying
   * the instance transform's full 4×4. Cost: 8 corner transforms per instance.
   */
  private ensureWorldAabbs(): void {
    if (this.worldAabbs) return;
    const n = this.buffers.instanceCount;
    const out = new Float32Array(n * 6);
    const i2m = new Uint32Array(n);

    for (let m = 0; m < this.drawInfos.length; m++) {
      const di = this.drawInfos[m]!;
      const [lx, ly, lz] = di.aabbMin;
      const [ux, uy, uz] = di.aabbMax;
      const firstInst = di.firstInstance;
      const instCount = di.instanceCount;
      for (let i = 0; i < instCount; i++) {
        const inst = firstInst + i;
        i2m[inst] = m;
        const t = this.buffers.getInstanceTransform(inst);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let c = 0; c < 8; c++) {
          const cx = (c & 1) ? ux : lx;
          const cy = (c & 2) ? uy : ly;
          const cz = (c & 4) ? uz : lz;
          const wx = t[0]! * cx + t[4]! * cy + t[ 8]! * cz + t[12]!;
          const wy = t[1]! * cx + t[5]! * cy + t[ 9]! * cz + t[13]!;
          const wz = t[2]! * cx + t[6]! * cy + t[10]! * cz + t[14]!;
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wz < minZ) minZ = wz;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
          if (wz > maxZ) maxZ = wz;
        }
        const a = inst * 6;
        out[a] = minX; out[a + 1] = minY; out[a + 2] = minZ;
        out[a + 3] = maxX; out[a + 4] = maxY; out[a + 5] = maxZ;
      }
    }
    this.worldAabbs = out;
    this.instanceToMesh = i2m;
  }

  /**
   * Test the ray against every triangle of one instance. Dequantises vertices
   * on demand and applies the instance transform.
   */
  private intersectInstance(ray: Ray, instanceIndex: number, meshIndex: number, currentBest: number): Intersection | null {
    const di = this.drawInfos[meshIndex]!;
    const transform = this.buffers.getInstanceTransform(instanceIndex);
    const expressId = this.buffers.getInstanceExpressId(instanceIndex);

    const vertexBase = di.vertexOffset; // base vertex
    const indexStart = di.indexOffset;
    const indexEnd = indexStart + di.indexCount;
    const indices = this.indexData;
    const vertices = this.vertexData;

    const [aabbMinX, aabbMinY, aabbMinZ] = di.aabbMin;
    const [aabbMaxX, aabbMaxY, aabbMaxZ] = di.aabbMax;
    const rangeX = aabbMaxX - aabbMinX;
    const rangeY = aabbMaxY - aabbMinY;
    const rangeZ = aabbMaxZ - aabbMinZ;

    // Avoid allocating Vec3 objects in the inner loop — pull them into locals.
    let bestT = currentBest;
    let bestPx = 0, bestPy = 0, bestPz = 0;
    let bestNx = 0, bestNy = 0, bestNz = 0;
    let bestU = 0, bestV = 0, bestW = 0;
    let bestTri = -1;
    let foundHit = false;

    for (let i = indexStart; i < indexEnd; i += 3) {
      const i0 = (vertexBase + indices[i]!) >>> 0;
      const i1 = (vertexBase + indices[i + 1]!) >>> 0;
      const i2 = (vertexBase + indices[i + 2]!) >>> 0;

      const v0x = decodePosX(vertices, i0, aabbMinX, rangeX);
      const v0y = decodePosY(vertices, i0, aabbMinY, rangeY);
      const v0z = decodePosZ(vertices, i0, aabbMinZ, rangeZ);
      const v1x = decodePosX(vertices, i1, aabbMinX, rangeX);
      const v1y = decodePosY(vertices, i1, aabbMinY, rangeY);
      const v1z = decodePosZ(vertices, i1, aabbMinZ, rangeZ);
      const v2x = decodePosX(vertices, i2, aabbMinX, rangeX);
      const v2y = decodePosY(vertices, i2, aabbMinY, rangeY);
      const v2z = decodePosZ(vertices, i2, aabbMinZ, rangeZ);

      // Apply instance transform — column-major mat4 * vec4(p, 1).
      const w0x = transform[0]! * v0x + transform[4]! * v0y + transform[ 8]! * v0z + transform[12]!;
      const w0y = transform[1]! * v0x + transform[5]! * v0y + transform[ 9]! * v0z + transform[13]!;
      const w0z = transform[2]! * v0x + transform[6]! * v0y + transform[10]! * v0z + transform[14]!;
      const w1x = transform[0]! * v1x + transform[4]! * v1y + transform[ 8]! * v1z + transform[12]!;
      const w1y = transform[1]! * v1x + transform[5]! * v1y + transform[ 9]! * v1z + transform[13]!;
      const w1z = transform[2]! * v1x + transform[6]! * v1y + transform[10]! * v1z + transform[14]!;
      const w2x = transform[0]! * v2x + transform[4]! * v2y + transform[ 8]! * v2z + transform[12]!;
      const w2y = transform[1]! * v2x + transform[5]! * v2y + transform[ 9]! * v2z + transform[13]!;
      const w2z = transform[2]! * v2x + transform[6]! * v2y + transform[10]! * v2z + transform[14]!;

      // Möller–Trumbore.
      const e1x = w1x - w0x, e1y = w1y - w0y, e1z = w1z - w0z;
      const e2x = w2x - w0x, e2y = w2y - w0y, e2z = w2z - w0z;
      const hx = ray.direction.y * e2z - ray.direction.z * e2y;
      const hy = ray.direction.z * e2x - ray.direction.x * e2z;
      const hz = ray.direction.x * e2y - ray.direction.y * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det > -EPSILON && det < EPSILON) continue;
      const invDet = 1 / det;
      const sx = ray.origin.x - w0x;
      const sy = ray.origin.y - w0y;
      const sz = ray.origin.z - w0z;
      const u = invDet * (sx * hx + sy * hy + sz * hz);
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = invDet * (ray.direction.x * qx + ray.direction.y * qy + ray.direction.z * qz);
      if (v < 0 || u + v > 1) continue;
      const t = invDet * (e2x * qx + e2y * qy + e2z * qz);
      if (t < EPSILON || t >= bestT) continue;

      bestT = t;
      bestPx = ray.origin.x + ray.direction.x * t;
      bestPy = ray.origin.y + ray.direction.y * t;
      bestPz = ray.origin.z + ray.direction.z * t;
      // Triangle normal in world space.
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen > EPSILON) {
        nx /= nLen; ny /= nLen; nz /= nLen;
      } else {
        nx = 0; ny = 0; nz = 1;
      }
      bestNx = nx; bestNy = ny; bestNz = nz;
      bestU = u; bestV = v; bestW = 1 - u - v;
      bestTri = (i - indexStart) / 3;
      foundHit = true;
    }

    if (!foundHit) return null;
    return {
      point: { x: bestPx, y: bestPy, z: bestPz },
      normal: { x: bestNx, y: bestNy, z: bestNz },
      distance: bestT,
      meshIndex,
      triangleIndex: bestTri,
      expressId,
      barycentricCoord: { u: bestU, v: bestV, w: bestW },
    };
  }

  /**
   * Materialise the closest `maxCandidates` instances along the ray as
   * world-space `MeshData[]` for the snap detector. Combines broad-phase
   * AABB triage with `QuantizedSceneBuffers.materializeInstancesAsMeshData`
   * so callers don't have to plumb the snapshot themselves.
   */
  materializeCandidatesNearRay(ray: Ray, maxCandidates = 32): MeshData[] {
    const candidates = this.candidatesAlongRay(ray);
    if (candidates.length === 0) return [];
    const limit = Math.min(maxCandidates, candidates.length);
    const indices: number[] = new Array(limit);
    for (let i = 0; i < limit; i++) {
      indices[i] = candidates[i]!.instance;
    }
    const materialized = this.buffers.materializeInstancesAsMeshData(
      indices,
      this.vertexData,
      this.indexData,
    );
    // MaterializedMeshData → MeshData (same shape minus optional fields).
    return materialized as unknown as MeshData[];
  }

  /**
   * Single-ray broad-phase: returns the list of instance indices whose world
   * AABB the ray passes through, in entry-order. Exposed for callers that
   * want to do their own narrow phase (e.g. snap detection over edges).
   */
  candidatesAlongRay(ray: Ray): { instance: number; tEnter: number }[] {
    this.ensureWorldAabbs();
    const aabbs = this.worldAabbs!;
    const out: { instance: number; tEnter: number }[] = [];
    const invDx = ray.direction.x !== 0 ? 1 / ray.direction.x : Infinity;
    const invDy = ray.direction.y !== 0 ? 1 / ray.direction.y : Infinity;
    const invDz = ray.direction.z !== 0 ? 1 / ray.direction.z : Infinity;
    for (let inst = 0; inst < this.buffers.instanceCount; inst++) {
      const a = inst * 6;
      const tEnter = rayAabb(
        ray.origin.x, ray.origin.y, ray.origin.z,
        invDx, invDy, invDz,
        aabbs[a]!, aabbs[a + 1]!, aabbs[a + 2]!,
        aabbs[a + 3]!, aabbs[a + 4]!, aabbs[a + 5]!,
      );
      if (tEnter !== null) out.push({ instance: inst, tEnter });
    }
    out.sort((a, b) => a.tEnter - b.tEnter);
    return out;
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/** Slab-test ray vs AABB. Returns enter-t (≥0 if origin inside) or null. */
function rayAabb(
  ox: number, oy: number, oz: number,
  invDx: number, invDy: number, invDz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number | null {
  const t1x = (minX - ox) * invDx;
  const t2x = (maxX - ox) * invDx;
  const t1y = (minY - oy) * invDy;
  const t2y = (maxY - oy) * invDy;
  const t1z = (minZ - oz) * invDz;
  const t2z = (maxZ - oz) * invDz;
  const tmin = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
  const tmax = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
  if (tmax < 0 || tmin > tmax) return null;
  return Math.max(0, tmin);
}

/** Unpack one quantised vertex axis. `vertexIdx` is the absolute vertex index. */
function decodePosX(vertices: Uint8Array, vertexIdx: number, aabbMin: number, range: number): number {
  const off = vertexIdx * QUANTIZED_VERTEX_STRIDE;
  const q = vertices[off]! | (vertices[off + 1]! << 8);
  return aabbMin + range * (q * U16_RECIP);
}
function decodePosY(vertices: Uint8Array, vertexIdx: number, aabbMin: number, range: number): number {
  const off = vertexIdx * QUANTIZED_VERTEX_STRIDE + 2;
  const q = vertices[off]! | (vertices[off + 1]! << 8);
  return aabbMin + range * (q * U16_RECIP);
}
function decodePosZ(vertices: Uint8Array, vertexIdx: number, aabbMin: number, range: number): number {
  const off = vertexIdx * QUANTIZED_VERTEX_STRIDE + 4;
  const q = vertices[off]! | (vertices[off + 1]! << 8);
  return aabbMin + range * (q * U16_RECIP);
}

