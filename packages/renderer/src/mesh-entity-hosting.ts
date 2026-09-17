/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

/**
 * True when `mesh` is a genuinely colour-merged mesh: its per-vertex
 * `entityIds` name at least one entity other than its own `expressId`, so
 * removing the owner must keep the geometry for the entities it still hosts.
 *
 * A mesh with no `entityIds`, or with `entityIds` naming only its own id (every
 * authored element from the viewer's `addElementMeshes` carries these), is a
 * dedicated mesh and is dropped on removal. `Scene.removeMeshesForEntity` and
 * the viewer's store-side mesh prune (#4874) both use this rule, so the store
 * and the scene agree on which meshes a split or delete removes.
 */
export function hostsOtherEntities(mesh: Pick<MeshData, 'expressId' | 'entityIds'>): boolean {
  const ids = mesh.entityIds;
  if (!ids) return false;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== mesh.expressId) return true;
  }
  return false;
}
