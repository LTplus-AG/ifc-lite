/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-entity mesh areas a backing generation keeps for released geometry (#10264), taken while each appended
 * slice is still resident. Pieces of one entity across slices add up exactly as one pass over the whole list
 * would (`collectMeshAreas` groups by entity).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { collectMeshAreas, type MeshAreaEntry } from '@/components/viewer/tools/measure-modes/mesh-area';

export type MeshAreas = Map<number, MeshAreaEntry>;

export function addMeshAreas(areas: MeshAreas, slice: readonly MeshData[]): void {
  for (const [id, entry] of collectMeshAreas([slice as MeshData[]])) {
    const prior = areas.get(id);
    areas.set(id, prior ? { area: prior.area + entry.area, incomplete: prior.incomplete || entry.incomplete } : entry);
  }
}
