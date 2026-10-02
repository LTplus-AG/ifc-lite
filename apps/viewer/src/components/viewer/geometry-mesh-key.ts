/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** A source slot, not an IFC item: one element/item may have multiple parts. */
export function geometryMeshKey(mesh: Pick<MeshData, 'expressId'>, index: number): string {
  return `${mesh.expressId}:${index}`;
}
