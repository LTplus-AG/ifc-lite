/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models a whole-model rotation must refuse, and why.
 *
 * A rotation is baked into `geometryResult.meshes`, and — since #4890 — into
 * the renderer's GPU-instanced occurrence transforms too
 * (`Renderer.setModelRotation`, pushed by `useModelRotationSync.ts`'s bake).
 * The one kind of geometry that still never passes through either path is a
 * pointcloud: a renderer handle carrying only a translation. Rotating one
 * would turn part of the selection and leave the cloud behind, so the command
 * is refused instead of half-applied.
 */

import type { ViewerState } from '@/store';

export const POINTCLOUD_ROTATION_REFUSAL = 'Pointclouds cannot be rotated. Select only IFC models to rotate.';

type RefusalState = Pick<ViewerState, 'models'>;

/** The reason rotating `ids` must be refused, or null when it may proceed. One
 * refusing model refuses the whole selection, which undoes as one command. */
export function rotationRefusal(state: RefusalState, ids: Iterable<string>): string | null {
  const list = [...ids];
  if (list.some((id) => state.models.get(id)?.pointCloudHandleId !== undefined)) return POINTCLOUD_ROTATION_REFUSAL;
  return null;
}
