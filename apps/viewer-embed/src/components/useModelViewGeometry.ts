/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the embed draws, and the signal that says the answer changed shape.
 *
 * Extracted from `EmbedViewer` rather than exempted from the ~400-line house
 * rule (AGENTS.md), which is what the ratchet is for. It is a cohesive unit on
 * its own terms: the Model-view gate, the host's `?hideTypes=` list and the
 * semantic toggles all decide the same question, and the content version is
 * derived from the same predicate as the gate, so keeping them together is what
 * stops the two drifting.
 */

import { useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { geometryClassOf } from '@ifc-lite/geometry/geometry-class';
import { isMeshVisibleInViewMode, meshClassIsPlaced } from '@/lib/type-view-visibility';
import type { TypeVisibility } from '@/store/types';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import { isIfcTypeHiddenByHost } from '@/lib/host-hidden-ifc-types.js';

interface GeometryResultLike {
  meshes?: MeshData[];
}

export interface ModelViewGeometry {
  /** The mesh list to hand `Viewport`, or null before anything is loaded. */
  geometry: MeshData[] | null;
  /**
   * Bumps when `selectModelMeshes` changes WHICH meshes it keeps, which happens
   * once, when the first placed mesh arrives and orphan type geometry stops
   * being the whole model. The upload path classifies by array length and
   * appends `slice(oldLength)` (`useGeometryStreaming.ts:321,516`), so it assumes
   * the list only grows at the tail. A composition change under a growing length
   * would leave the dropped orphans on screen and never upload the placed meshes
   * that took their index range. `geometryContentVersion` is the existing escape
   * hatch for exactly that, so flipping it forces the full re-upload.
   */
  contentVersion: number;
}

export function useModelViewGeometry(
  merged: GeometryResultLike | null | undefined,
  hiddenTypes: ReadonlySet<string> | null,
  typeVisibility: TypeVisibility,
): ModelViewGeometry {
  // One scan, two consumers. `selectModelMeshes` would compute exactly this
  // internally and the version needs it too, so calling the wrapper here would
  // walk the list twice per streaming batch for the same answer.
  // `isMeshVisibleInViewMode` is the predicate underneath it, and taking it
  // directly is what `ViewportContainer` does for the same reason.
  const hasPlacedGeometry = useMemo(
    () => (merged?.meshes ?? []).some((m) => meshClassIsPlaced(geometryClassOf(m))),
    [merged],
  );
  const contentVersion = hasPlacedGeometry ? 1 : 0;

  const geometry = useMemo(() => {
    if (!merged?.meshes) return null;
    // The embed renders the Model view: placed occurrences and material-layer
    // slices; type-library geometry is never drawn (#957, #1353). The full
    // viewer's predicate, whole: a file with nothing placed keeps its orphans.
    let meshes = merged.meshes.filter((m) =>
      isMeshVisibleInViewMode(geometryClassOf(m), 'model', hasPlacedGeometry),
    );
    // The toggle half goes through `isTypeVisible`, the store's single source of
    // truth for the class -> toggle mapping. A private copy here named three of
    // the seven mapped classes, so IfcSpatialZone, IfcVirtualElement,
    // IfcGeographicElement and 3D IfcAnnotation solids ignored their toggles.
    meshes = meshes.filter(
      (mesh) => !isIfcTypeHiddenByHost(mesh.ifcType, hiddenTypes) && isTypeVisible(mesh.ifcType, typeVisibility),
    );

    // Mesh alpha flows through unchanged. The embed used to re-multiply IfcSpace
    // and IfcOpeningElement down to `min(alpha * 0.3, 0.3)` here; the full viewer
    // dropped exactly that under #677 because it stomped lens and property-set
    // colour rules even when the caller had explicitly chosen alpha 1.0. Defaults
    // still come from styling.rs, which already assigns IfcSpace 0.3 and
    // IfcOpeningElement 0.4, so the translucency survives without being applied
    // twice.
    return meshes;
  }, [merged, typeVisibility, hiddenTypes, hasPlacedGeometry]);

  return { geometry, contentVersion };
}
