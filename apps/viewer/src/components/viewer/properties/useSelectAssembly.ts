/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';

import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';

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
    const s = useViewerStore.getState();
    const selected = s.selectedEntity;
    if (!selected) return;
    const globalId = toGlobalIdFromModels(s.models, selected.modelId, expressId);

    // An assembly owns no mesh of its own and the renderer highlights by
    // mesh-id match, so selecting the bare id cleared the part's highlight and
    // lit nothing in its place -- the camera moved to the right place while
    // nothing lit up (Viewport.tsx:1156-1167). Highlight the renderable parts,
    // assembly id LAST so it stays primary (#1133), the shape
    // SearchModal.text and HierarchyPanel already use.
    const renderableParts = s.cameraCallbacks.resolveHighlightIds?.([globalId]) ?? [];
    s.setSelectedEntityIds([...renderableParts, globalId]);
    s.setSelectedEntityId(globalId);
    s.setSelectedEntity({ modelId: selected.modelId, expressId });

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
  }, []);
}
