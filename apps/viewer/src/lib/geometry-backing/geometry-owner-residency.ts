/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { SceneContents } from '@ifc-lite/renderer';
import { meshIsResident } from './geometry-readback';

export type GeometryOwnerScene = Partial<Pick<SceneContents, 'getInstancedModelIndices'>>
  & { isGeometryDataReleased?: () => boolean };

/** Flat pieces and GPU instance ownership must both be checked per model. */
export function geometryOwnerNeedsReadback(
  meshes: readonly MeshData[], scene: GeometryOwnerScene | undefined, modelIndex: number,
): boolean {
  if (!meshes.every(meshIsResident)) return true;
  if (!scene?.isGeometryDataReleased?.()) return false;
  // Hosts lacking ownership information cannot prove that instances are resident.
  return typeof scene.getInstancedModelIndices !== 'function'
    || scene.getInstancedModelIndices().includes(modelIndex);
}
