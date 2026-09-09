/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { resolveEntityRef, useViewerStore } from '@/store';
import { createEntityBoundsLookup, unionEntityBounds } from '@/utils/viewportUtils';
import { displayedTranslation } from './state';
import { toRenderTranslation } from './translation';

/** Validate source vertices before applying a deliberate large model offset. */
export function createPlacedEntityBoundsLookup(meshes: MeshData[] | null) {
  const sourceBounds = createEntityBoundsLookup(meshes), state = useViewerStore.getState();
  return (id: number) => {
    const box = sourceBounds(id); if (!box) return null;
    const [x, y, z] = toRenderTranslation(displayedTranslation(state.modelPlacement, resolveEntityRef(id).modelId));
    return { min: { x: box.min.x + x, y: box.min.y + y, z: box.min.z + z },
      max: { x: box.max.x + x, y: box.max.y + y, z: box.max.z + z } };
  };
}

export function placedBoundsExcludingTypes(meshes: MeshData[], excluded: ReadonlySet<string>) {
  const included = meshes.filter((mesh) => !mesh.ifcType || !excluded.has(mesh.ifcType));
  return unionEntityBounds(null, [...new Set(included.map((mesh) => mesh.expressId))], createPlacedEntityBoundsLookup(included));
}
