/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models a whole-model rotation must refuse, and why.
 *
 * A rotation is baked into `geometryResult.meshes`. Two kinds of geometry never
 * pass through there: a pointcloud (a renderer handle carrying only a
 * translation) and GPU-instanced occurrences (#1912), which the renderer draws
 * from its own instance data. Rotating either would turn part of the model and
 * leave the rest behind, so the command is refused instead of half-applied.
 * Rotating instanced geometry is tracked as a follow-up.
 */

import type { ViewerState } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { modelIndices } from './model-indices.js';

export const POINTCLOUD_ROTATION_REFUSAL = 'Pointclouds cannot be rotated. Select only IFC models to rotate.';
export const INSTANCED_ROTATION_REFUSAL =
  'Models with GPU-instanced geometry cannot be rotated yet. Select only models without instanced geometry to rotate.';
export const LOADING_ROTATION_REFUSAL = 'Wait for the model to finish loading before rotating it.';

type RefusalState = Pick<ViewerState, 'models' | 'pendingInstancedShards'>;

/**
 * True when any of the model's geometry is drawn GPU-instanced. Three signals,
 * because each covers a moment the others miss: the instanced-only entity maps
 * on a finished geometry, shard bytes queued but not yet uploaded, and the
 * renderer's own templates (which also catch an entity only partly instanced).
 */
export function modelHasInstancedGeometry(state: RefusalState, modelId: string): boolean {
  const geometry = state.models.get(modelId)?.geometryResult;
  if ((geometry?.instancedGeometryHashes?.size ?? 0) > 0 || (geometry?.instancedGeometryAabbs?.size ?? 0) > 0) return true;
  if (state.pendingInstancedShards?.some((shard) => shard.modelId === modelId)) return true;
  const owners = getGlobalRenderer()?.getScene().getInstancedModelIndices();
  if (!owners || owners.length === 0) return false;
  const index = modelIndices(state.models).get(modelId);
  return index !== undefined && owners.includes(index);
}

/** The reason rotating `ids` must be refused, or null when it may proceed. One
 * refusing model refuses the whole selection, which undoes as one command. */
export function rotationRefusal(state: RefusalState, ids: Iterable<string>): string | null {
  const list = [...ids];
  if (list.some((id) => state.models.get(id)?.pointCloudHandleId !== undefined)) return POINTCLOUD_ROTATION_REFUSAL;
  // Instancing is only known once shards arrive, so a streaming model cannot
  // yet be shown to be safe.
  if (list.some((id) => ['pending', 'streaming-geometry'].includes(state.models.get(id)?.loadState ?? ''))) {
    return LOADING_ROTATION_REFUSAL;
  }
  if (list.some((id) => modelHasInstancedGeometry(state, id))) return INSTANCED_ROTATION_REFUSAL;
  return null;
}
