/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The meshes a section cut slices: what is on screen, not everything loaded.
 *
 * Shared by the active plane's drawing (`useDrawingGeneration`) and the caps of
 * the other cutting planes (`useExtraSectionCaps`, #7545), so every cap is cut
 * from the same set and a hidden IfcSpace never shows in one plane's cap and
 * not another's.
 */

import { selectModelMeshes } from '@/lib/type-view-visibility';
import { isTypeVisible, type TypeVisibilityGate } from '@/store/typeVisibilityFilter';

export interface CutMeshVisibility {
  /** Class-level Visibility toggles (Spaces, Openings, Site, …): a global filter, not 3D-only (#2060). */
  typeVisibility: TypeVisibilityGate;
  /** Hidden entities (global ids, so every federated model is covered). */
  hiddenIds: ReadonlySet<number>;
  /** Isolation, when one is active. */
  isolatedIds: ReadonlySet<number> | null;
  /**
   * Storey selection. Meaningfully nullable, like `isolatedIds` and
   * `packages/renderer/src/entity-visibility.ts`'s `isEntityVisible`: null or
   * undefined means no isolation channel is active, while a non-null Set, an
   * EMPTY one included, means one is and matches nothing.
   */
  computedIsolatedIds?: ReadonlySet<number> | null;
}

interface CutMesh { expressId: number; ifcType?: string; geometryClass?: number }

/** The meshes of `all` (the whole scene) that a cut should slice. */
export function visibleCutMeshes<T extends CutMesh>(all: readonly T[], visibility: CutMeshVisibility): T[] {
  // Type-library geometry (IfcTypeProduct RepresentationMap copies, #2058) is not part of the model view.
  let meshes = selectModelMeshes(all).filter((mesh) => isTypeVisible(mesh.ifcType, visibility.typeVisibility));
  if (visibility.hiddenIds.size > 0) meshes = meshes.filter((mesh) => !visibility.hiddenIds.has(mesh.expressId));
  const isolated = visibility.isolatedIds;
  if (isolated !== null) meshes = meshes.filter((mesh) => isolated.has(mesh.expressId));
  const computed = visibility.computedIsolatedIds;
  if (computed != null) meshes = meshes.filter((mesh) => computed.has(mesh.expressId));
  return meshes;
}
