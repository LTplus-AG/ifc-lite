/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook to sync selectedEntityId with selectedEntity (model-aware selection)
 *
 * When an entity is selected (via click or other means), this hook:
 * 1. Watches for changes to selectedEntityId (which is now a globalId)
 * 2. Uses store-based resolver to find (modelId, originalExpressId)
 * 3. Updates selectedEntity with { modelId, expressId } for PropertiesPanel
 *
 * IMPORTANT: selectedEntityId is a globalId (transformed at load time)
 * The EntityRef.expressId is the ORIGINAL expressId for property lookup
 *
 * NOTE: We use resolveGlobalIdFromModels (store-based) instead of the singleton
 * federationRegistry because it's more reliable - the Zustand store is always
 * in sync with React, whereas the singleton might have bundling issues.
 */

import { useEffect } from 'react';
import { useViewerStore } from '../store/index.js';
import { resolveEntityRef } from '../store/resolveEntityRef.js';

export function useModelSelection() {
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  // Subscribe to models for reactivity (when models are added/removed)
  const models = useViewerStore((s) => s.models);

  useEffect(() => {
    if (selectedEntityId === null) {
      // Don't clear selectedEntity when selectedEntityId is null
      // This allows selectedModelId to remain set when clicking model headers
      // The model selection flow: setSelectedModelId -> sets selectedEntityId=null
      // If we called setSelectedEntity(null) here, it would clear selectedModelId
      return;
    }

    // Single source of truth: resolveEntityRef handles globalId → EntityRef
    // including fallback for single-model mode (offset 0). Always returns an EntityRef.
    setSelectedEntity(resolveEntityRef(selectedEntityId));
  }, [selectedEntityId, setSelectedEntity, models]);
}
