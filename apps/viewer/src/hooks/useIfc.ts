/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orchestrator hook for loading and processing IFC files
 * Composes sub-hooks for server communication, file loading, and multi-model federation
 *
 * Sub-hooks:
 * - useIfcServer: Server reachability, streaming/Parquet/JSON parsing paths
 * - useIfcLoader: Single-model file loading, format detection, WASM geometry streaming, cache
 * - useIfcFederation: Multi-model federation, addModel, ID offsets, RTC alignment, IFCX layers
 */

import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { IfcQuery } from '@ifc-lite/query';
import type { IfcDataStore } from '@ifc-lite/parser';

// Sub-hooks
import { useIfcLoader } from './useIfcLoader.js';
import { useIfcFederation } from './useIfcFederation.js';

export function useIfc() {
  const {
    loading,
    progress,
    geometryProgress,
    metadataProgress,
    error,
    ifcDataStore,
    geometryResult,
    // Multi-model state and actions
    models,
    activeModelId,
    clearAllModels,
    setActiveModel,
    setModelVisibility,
    setModelCollapsed,
    getModel,
    getActiveModel,
    getAllVisibleModels,
    hasModels,
    // Federation Registry helpers
    toGlobalId,
  } = useViewerStore(useShallow((s) => ({
    loading: s.loading,
    progress: s.progress,
    geometryProgress: s.geometryProgress,
    metadataProgress: s.metadataProgress,
    error: s.error,
    ifcDataStore: s.ifcDataStore,
    geometryResult: s.geometryResult,
    models: s.models,
    activeModelId: s.activeModelId,
    clearAllModels: s.clearAllModels,
    setActiveModel: s.setActiveModel,
    setModelVisibility: s.setModelVisibility,
    setModelCollapsed: s.setModelCollapsed,
    getModel: s.getModel,
    getActiveModel: s.getActiveModel,
    getAllVisibleModels: s.getAllVisibleModels,
    hasModels: s.hasModels,
    toGlobalId: s.toGlobalId,
  })));

  // Track if we've already logged for this ifcDataStore
  const lastLoggedDataStoreRef = useRef<typeof ifcDataStore>(null);

  // File loading (single-model path)
  const { loadFile } = useIfcLoader();

  // Multi-model federation
  const {
    addModel,
    removeModel,
    getQueryForModel,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    findModelForEntity,
    resolveGlobalId,
    realignFederation,
  } = useIfcFederation();

  // Memoize query to prevent recreation on every render
  // For single-model backward compatibility
  const query = useMemo(() => {
    if (!ifcDataStore) return null;

    // Only log once per ifcDataStore
    lastLoggedDataStoreRef.current = ifcDataStore;

    return new IfcQuery(ifcDataStore);
  }, [ifcDataStore]);

  return {
    // Legacy single-model API (backward compatibility)
    loading,
    progress,
    geometryProgress,
    metadataProgress,
    error,
    ifcDataStore,
    geometryResult,
    query,
    loadFile,

    // Multi-model API
    models,
    activeModelId,
    addModel,
    removeModel,
    clearAllModels,
    setActiveModel,
    setModelVisibility,
    setModelCollapsed,
    getModel,
    getActiveModel,
    getAllVisibleModels,
    hasModels,
    getQueryForModel,
    loadFilesSequentially,

    // Federated IFCX API (IFC5 multi-file loading with layer composition)
    loadFederatedIfcx,  // Load multiple IFCX files as federated layers
    addIfcxOverlays,    // Add overlay files to existing federated model

    // Federation Registry helpers
    findModelForEntity,  // Find model by globalId
    resolveGlobalId,     // Convert globalId -> (modelId, originalExpressId)
    toGlobalId,          // Convert (modelId, expressId) -> globalId

    // Federation alignment (cross-CRS reprojection + anchor management)
    realignFederation,   // Re-bake every model's geometry against the current anchor
  };
}
