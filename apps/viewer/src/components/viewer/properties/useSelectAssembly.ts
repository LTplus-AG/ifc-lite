/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';

import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { EntityRef } from '@/store/types';

/**
 * Select the parent `IfcElementAssembly` from the "Part of Assembly" badge
 * (#3620).
 *
 * Not `handleSelectRelatedEntity`: that leaves `selectedEntityId` -- the
 * globalId the properties panel's own render gate requires -- at whatever
 * `setSelectedEntityIds([])` derives, which is null, so its target never
 * becomes visible in the panel. `setSelectedEntityId` is the field every
 * 3D-pick and search entry point sets first, for that reason.
 */
export function useSelectAssembly(): (expressId: number) => void {
  return useCallback((expressId: number) => {
    const selected = useViewerStore.getState().selectedEntity;
    if (selected) selectOnlyEntity({ modelId: selected.modelId, expressId });
  }, []);
}

/**
 * Replace the whole selection with one entity on both selection channels and
 * frame it. Also narrows a multi-selection to one of its members (#5900).
 * `parts` (express ids in the same model) are highlighted and framed with it:
 * a group such as an IfcStructuralAnalysisModel owns no mesh and no
 * aggregated parts, so its assigned members stand in for it (#10605).
 */
export function selectOnlyEntity(ref: EntityRef, parts: readonly number[] = []): void {
  const s = useViewerStore.getState();
  const globalId = toGlobalIdFromModels(s.models, ref.modelId, ref.expressId);
  const partIds = parts.map((expressId) => toGlobalIdFromModels(s.models, ref.modelId, expressId));

  // An assembly owns no mesh of its own and the renderer highlights by
  // mesh-id match, so selecting the bare id cleared the part's highlight and
  // lit nothing in its place -- the camera moved to the right place while
  // nothing lit up (Viewport.tsx:1156-1167). Highlight the renderable parts,
  // assembly id LAST so it stays primary (#1133), the shape
  // SearchModal.text and HierarchyPanel already use.
  const renderableParts = s.cameraCallbacks.resolveHighlightIds?.([...partIds, globalId]) ?? [];
  // Parts stay even when the resolver drops them: a structural member the
  // current structural view mode filters out is not renderable yet.
  const highlighted = partIds.length === 0 ? renderableParts
    : [...new Set([...renderableParts, ...partIds])].filter((id) => id !== globalId);
  s.setSelectedEntityIds([...highlighted, globalId]);
  s.setSelectedEntityId(globalId);
  s.setSelectedEntity(ref);

  // MeasureQuantities, basketVisibleSet, useBCF and the LLM context builder
  // read this model-aware set in preference to `selectedEntity`, so one left
  // standing keeps reporting the entities selected BEFORE this click. The
  // canonical single-select path clears it too (Viewport.tsx:198-200).
  if (s.selectedEntitiesSet.size > 0) {
    useViewerStore.setState({ selectedEntitiesSet: new Set<string>() });
  }

  if (s.cameraCallbacks.frameSelection) {
    window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
  }
}
