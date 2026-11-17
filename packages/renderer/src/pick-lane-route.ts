/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The batch pick route (#10264 S1), the scene half: which drawables a GPU pick
 * must draw whole, whether it can draw all of them, and how an entity sample
 * becomes a full `PickResult`.
 *
 * It replaces the CPU raycast for models over the pick-mesh budget. The GPU
 * pass only knows the entity, so on a model that keeps its CPU geometry the
 * picked entity is raycast on the CPU again, alone, for its model index and
 * representation item: one entity's triangles instead of the whole scene's.
 */

import type { BatchedMesh, Mesh, Vec3 } from './types.js';
import type { PickClipState, PickOptions } from './pick-types.js';
import { reportableItemId, type PickResult } from './pick-resolve.js';
import type { Scene } from './scene.js';
import type { LanePickDraw } from './lane-pick-pass.js';
import { batchEntityIdAnchor } from './entity-color-table.js';
import { isEntityVisible } from './entity-visibility.js';
import { prepareRayDirInv, raycastTriangles, type RaycastHit } from './scene-raycaster.js';

/** A lane sample keeps the low 30 bits of the id (bit 30 is the entity-sample marker). */
const LANE_SAMPLE_ID_LIMIT = 0x40000000;
/** Ids under one anchor span 2^24 (`entityIdAnchor`). */
const LANE_PAGE_SPAN = 0x01000000;

export type LaneRouteScene = Pick<Scene,
  | 'getBatchedMeshes' | 'getTexturedMeshes' | 'getMeshes' | 'hasPendingBatches' | 'isFinalizeInProgress'
  | 'getMeshDataPieceList' | 'isInstancedEntity' | 'getInstancedMeshDataPieces'
  | 'getEntityBoundingBox' | 'getInstancedEntityBounds'>;

export interface Ray { origin: Vec3; direction: Vec3 }

/**
 * Whether the infinite line through `ray` meets `box` grown by a margin. A
 * line, not a half-line: the rasteriser draws whatever lies between the clip
 * planes, which an orthographic ray origin need not be in front of. The
 * margin covers f32 rasterisation at the box faces and is generous on purpose:
 * drawing an extra batch costs a draw, missing one would lose a hit.
 */
export function lineMeetsBox(ray: Ray, box: { min: readonly number[]; max: readonly number[] }): boolean {
  const o = [ray.origin.x, ray.origin.y, ray.origin.z];
  const d = [ray.direction.x, ray.direction.y, ray.direction.z];
  let lo = -Infinity;
  let hi = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const min = box.min[axis]!;
    const max = box.max[axis]!;
    const pad = 1e-3 + 1e-6 * Math.max(Math.abs(min), Math.abs(max));
    const a = min - pad - o[axis]!;
    const b = max + pad - o[axis]!;
    if (d[axis] === 0) {
      if (a > 0 || b < 0) return false;
      continue;
    }
    const t0 = a / d[axis]!;
    const t1 = b / d[axis]!;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    if (lo > hi) return false;
  }
  return true;
}

function batchDraw(batch: BatchedMesh): LanePickDraw | null {
  const anchor = batchEntityIdAnchor(batch);
  if (anchor === null || anchor + LANE_PAGE_SPAN > LANE_SAMPLE_ID_LIMIT) return null;
  return {
    layout: batch.quantized ? 'quantized' : 'flat',
    vertexBuffer: batch.vertexBuffer,
    indexBuffer: batch.indexBuffer,
    indexCount: batch.indexCount,
    origin: batch.origin ?? [0, 0, 0],
    anchor,
    ...(batch.quantized ? { quantized: batch.quantized } : {}),
  };
}

/**
 * Every colour batch and textured mesh a pick along `ray` can hit (all of them
 * for a marquee, `ray` null), or `null` when the GPU cannot answer for all of
 * them right now and the caller must take the CPU route instead:
 * - batches are pending a rebuild or finalize is regrouping them, so the set
 *   on the GPU is not the scene's geometry;
 * - a batch the ray meets is evicted from the GPU (its buffers are destroyed);
 * - a batch's ids cannot be resolved from its lane or do not fit the sample.
 * Partial answers are never returned: a missing batch would silently lose its
 * elements from the pick.
 */
export function collectLaneDraws(scene: LaneRouteScene, ray: Ray | null): LanePickDraw[] | null {
  if (scene.hasPendingBatches() || scene.isFinalizeInProgress()) return null;
  const draws: LanePickDraw[] = [];
  for (const batch of scene.getBatchedMeshes()) {
    if (ray && batch.bounds && !lineMeetsBox(ray, batch.bounds)) continue;
    if (batch.gpuResident === false) return null;
    const draw = batchDraw(batch);
    if (!draw) return null;
    draws.push(draw);
  }
  for (const textured of scene.getTexturedMeshes()) {
    if (ray && textured.bounds && !lineMeetsBox(ray, textured.bounds)) continue;
    if (!Number.isInteger(textured.expressId) || textured.expressId < 0 || textured.expressId >= LANE_SAMPLE_ID_LIMIT) return null;
    draws.push({
      layout: 'textured',
      vertexBuffer: textured.vertexBuffer,
      indexBuffer: textured.indexBuffer,
      indexCount: textured.indexCount,
      origin: textured.origin,
      anchor: textured.expressId,
    });
  }
  return draws;
}

/**
 * Individual meshes the batch route still draws through the flat pick pipeline:
 * the ones that ARE scene geometry (`Renderer.addMesh`). Hydrated pick and
 * highlight copies duplicate batch geometry and are left out.
 */
export function laneRouteMeshes(scene: Pick<Scene, 'getMeshes'>, options?: PickOptions): Mesh[] {
  return scene.getMeshes().filter((mesh) => !mesh.hydrated && !mesh.mergedSelection
    && isEntityVisible(mesh.expressId, options?.hiddenIds, options?.isolatedIds));
}

/** The one model index every entry names, or undefined when none or several. */
function soleModelIndex(indices: Iterable<number | undefined>): number | undefined {
  let found: number | undefined;
  let seen = false;
  for (const index of indices) {
    if (seen && index !== found) return undefined;
    found = index;
    seen = true;
  }
  return found;
}

/** Model index of `id` from the batches' own entries, for a scene without CPU pieces. */
function batchModelIndex(batches: readonly BatchedMesh[], id: number): number | undefined {
  const indices: (number | undefined)[] = [];
  for (const batch of batches) {
    batch.expressIds.forEach((entry, i) => { if (entry === id) indices.push(batch.modelIndices?.[i]); });
  }
  return soleModelIndex(indices);
}

/**
 * Complete an entity sample (a batch lane or an instanced occurrence). The
 * GPU found `hit.expressId` as the nearest visible surface at the pick texel;
 * the CPU raycast along the same texel-centre ray, over that entity's pieces
 * only, says which piece: its model index and representation item, through the
 * same `reportableItemId` rule the full CPU route applies. The reported world
 * point stays the GPU's (reverse-Z depth under the immutable RTE snapshot).
 *
 * When the narrow raycast misses (a silhouette texel the f32 CPU test rounds
 * the other way), the entity's pieces still name the model and, if they all
 * agree, the item. A scene whose CPU geometry was released reports the entity
 * and its model only: the item needs the pieces.
 */
export function refineLaneHit(
  scene: LaneRouteScene,
  hit: PickResult,
  ray: Ray,
  options: PickOptions | undefined,
  clip: PickClipState | null | undefined,
): PickResult {
  const id = hit.expressId;
  const flat = scene.getMeshDataPieceList(id) ?? [];
  const instanced = scene.isInstancedEntity(id) ? scene.getInstancedMeshDataPieces(id) ?? [] : [];
  if (flat.length === 0 && instanced.length === 0) {
    const modelIndex = batchModelIndex(scene.getBatchedMeshes(), id);
    return modelIndex === undefined ? hit : { ...hit, modelIndex };
  }
  const { rayDirInv, rayDirSign } = prepareRayDirInv(ray.direction);
  const cast = (pieces: typeof flat, bounds: (key: number) => ReturnType<Scene['getEntityBoundingBox']>): RaycastHit | null =>
    pieces.length === 0 ? null : raycastTriangles(
      ray.origin, ray.direction, rayDirInv, rayDirSign, new Map([[id, [...pieces]]]), bounds,
      options?.hiddenIds, options?.isolatedIds, clip,
    );
  const flatHit = cast(flat, (key) => scene.getEntityBoundingBox(key));
  const instancedHit = cast(instanced, (key) => scene.getInstancedEntityBounds(key));
  const cpu = flatHit && instancedHit ? (instancedHit.distance < flatHit.distance ? instancedHit : flatHit) : flatHit ?? instancedHit;
  if (cpu) {
    return {
      expressId: id,
      ...(cpu.modelIndex !== undefined ? { modelIndex: cpu.modelIndex } : {}),
      ...(hit.worldXYZ ? { worldXYZ: hit.worldXYZ } : {}),
      ...(cpu.geometryItemId !== undefined ? { geometryItemId: cpu.geometryItemId } : {}),
    };
  }
  const pieces = [...flat, ...instanced];
  const modelIndex = soleModelIndex(pieces.map((piece) => piece.modelIndex));
  const items = new Set(pieces.map((piece) => reportableItemId(piece, id)));
  const item = items.size === 1 ? reportableItemId(pieces[0]!, id) : undefined;
  return {
    expressId: id,
    ...(modelIndex !== undefined ? { modelIndex } : {}),
    ...(hit.worldXYZ ? { worldXYZ: hit.worldXYZ } : {}),
    ...(item !== undefined ? { geometryItemId: item } : {}),
  };
}
