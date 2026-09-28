/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a GPU pick can afford to hydrate the individual pick meshes it
 * needs, for `PickingManager.prepareBatchedPick`. Extracted so the budget
 * verdict and the piece bookkeeping it needs live in one place.
 */

import type { PickOptions } from './types.js';
import type { Scene } from './scene.js';
import { isEntityVisible } from './entity-visibility.js';

/**
 * Most individual pick meshes one pick may hydrate. GPU picking needs a
 * buffer per piece, which is too slow at 60K+ elements, so a pick that would
 * create more takes the CPU raycast (no GPU buffers) instead.
 */
const MAX_PICK_MESH_CREATION = 500;

type PickMeshScene = Pick<Scene, 'getMeshes' | 'visibleMeshDataEntitiesExceed' | 'getAllMeshDataExpressIds' | 'getMeshDataPieces'>;

export interface PickMeshPlan {
  /** True when hydrating would exceed {@link MAX_PICK_MESH_CREATION}: take the CPU route. */
  overBudget: boolean;
  /** Visible pickable ids, in `expressIds` order. Empty when `overBudget`. */
  visibleExpressIds: number[];
  /** Existing pick-mesh pieces per `expressId:modelIndex` key. Empty when `overBudget`. */
  existingPieceCounts: Map<string, number>;
}

/** The key pieces are counted under: one entity in one model. */
export function pickPieceKey(piece: { expressId: number; modelIndex?: number }): string {
  return `${piece.expressId}:${piece.modelIndex ?? 'any'}`;
}

/**
 * Decide whether the visible pickable entities can be hydrated for a GPU
 * pick, and hand back the bookkeeping the hydration then needs.
 */
export function planPickMeshHydration(scene: PickMeshScene, options?: PickOptions): PickMeshPlan {
  const existing = scene.getMeshes();
  // Over-budget verdict from a count alone, before building the id set and
  // walking it, which costs O(entities) allocations, piece lookups and
  // colour-merged extractions: the hover pre-highlight (#5390) picks up to 20x
  // a second, and on a 127K-element model each pick spent on the order of
  // 100 ms here only to return 'cpu' (#6392). Every visible entity with mesh
  // data needs at least one piece and `getMeshes()` holds at most one per
  // existing piece, so `visible - existing` is a lower bound on the pieces to
  // create.
  if (scene.visibleMeshDataEntitiesExceed(existing.length + MAX_PICK_MESH_CREATION, options?.hiddenIds, options?.isolatedIds)) {
    return { overBudget: true, visibleExpressIds: [], existingPieceCounts: new Map() };
  }

  // Every pickable expressId: the scene's authoritative mesh-data id set rather
  // than each batch's `expressIds`, because a batch only records the PRIMARY
  // expressId of each merged piece. When a door or window is colour-fused into
  // a batch keyed by its host wall / opening, the filler's id lives only in the
  // per-vertex entityIds (registered in meshDataMap by Scene.addMeshData).
  // Reading batch.expressIds alone would skip the filler, so under isolation
  // its mesh is never hydrated and pick() returns null (#1358).
  const expressIds = new Set<number>(scene.getAllMeshDataExpressIds());

  // Track how many individual mesh pieces already exist for each (expressId:modelIndex).
  // Multi-piece elements (windows/doors with submeshes) need all pieces for reliable picking.
  const existingPieceCounts = new Map<string, number>();
  for (const mesh of existing) {
    const key = pickPieceKey(mesh);
    existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
  }

  // Build required piece counts from MeshData for all visible entities.
  const requiredPieceCounts = new Map<string, number>();
  const visibleExpressIds: number[] = [];
  for (const expressId of expressIds) {
    if (!isEntityVisible(expressId, options?.hiddenIds, options?.isolatedIds)) continue;
    visibleExpressIds.push(expressId);

    const pieces = scene.getMeshDataPieces(expressId);
    if (!pieces) continue;
    for (const piece of pieces) {
      const key = pickPieceKey(piece);
      requiredPieceCounts.set(key, (requiredPieceCounts.get(key) ?? 0) + 1);
    }
  }

  // Count how many meshes we'd need to create for full GPU picking
  // For multi-model and multi-piece elements, count missing piece instances per key.
  let toCreate = 0;
  for (const [key, requiredCount] of requiredPieceCounts) {
    const existingCount = existingPieceCounts.get(key) ?? 0;
    if (requiredCount > existingCount) {
      toCreate += requiredCount - existingCount;
    }
  }

  const overBudget = toCreate > MAX_PICK_MESH_CREATION || (visibleExpressIds.length > 0 && requiredPieceCounts.size === 0);
  return { overBudget, visibleExpressIds, existingPieceCounts };
}
