/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models a whole-model rotation must refuse, and why.
 *
 * A rotation is baked into `geometryResult.meshes`, and — since #4890 — into
 * the renderer's GPU-instanced occurrence transforms too
 * (`Renderer.setModelRotation`, pushed by `useModelRotationSync.ts`'s bake).
 * A pointcloud never passes through either path — a renderer handle carrying
 * only a translation — so rotating one would turn part of the selection and
 * leave the cloud behind, and the command is refused instead of half-applied.
 *
 * A model whose KIND is not yet knowable is refused too, for a narrower
 * reason: a primary LAS/E57 mid-ingest reports `loadState:
 * 'streaming-geometry'` but has no `pointCloudHandleId` until finalization
 * (#4890 review) — with no such refusal, a heading committed during that
 * window is either silently dropped once the pointcloud handle appears, or
 * lands on a model that can never turn. This must NOT catch an
 * instanced-but-streaming IFC model: instancing is knowable well before
 * loading finishes (`instancedGeometryHashes`/`instancedGeometryAabbs`
 * populate per shard), and refusing it would defeat the point of #4890.
 */

import type { ViewerState } from '@/store';

export const POINTCLOUD_ROTATION_REFUSAL = 'Pointclouds cannot be rotated. Select only IFC models to rotate.';
export const LOADING_ROTATION_REFUSAL = 'Wait for the model to finish loading before rotating it.';

type RefusalState = Pick<ViewerState, 'models'>;

/** True only while NOTHING has yet told us what `modelId` even is: still
 * streaming (or not started), no pointcloud handle, and no geometry signal
 * of any kind — no flat mesh, no instanced hash, no instanced box. Any one of
 * those settles the question and this returns false, streaming or not. */
function kindUnknown(state: RefusalState, modelId: string): boolean {
  const model = state.models.get(modelId);
  if (!model || (model.loadState !== 'pending' && model.loadState !== 'streaming-geometry')) return false;
  if (model.pointCloudHandleId !== undefined) return false;
  const geometry = model.geometryResult;
  if (geometry && (geometry.meshes.length > 0
    || (geometry.instancedGeometryHashes?.size ?? 0) > 0
    || (geometry.instancedGeometryAabbs?.size ?? 0) > 0)) return false;
  return true;
}

/** The reason rotating `ids` must be refused, or null when it may proceed. One
 * refusing model refuses the whole selection, which undoes as one command. */
export function rotationRefusal(state: RefusalState, ids: Iterable<string>): string | null {
  const list = [...ids];
  if (list.some((id) => state.models.get(id)?.pointCloudHandleId !== undefined)) return POINTCLOUD_ROTATION_REFUSAL;
  if (list.some((id) => kindUnknown(state, id))) return LOADING_ROTATION_REFUSAL;
  return null;
}
