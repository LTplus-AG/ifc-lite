/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import { Viewport } from './Viewport';
import { ViewportOverlays } from './ViewportOverlays';
import { ToolOverlays } from './ToolOverlays';
import { Section2DPanel } from './Section2DPanel';
import { BasketPresentationDock } from './BasketPresentationDock';
import { BCFOverlay } from './bcf/BCFOverlay';
import { CesiumOverlay } from './CesiumOverlay';
import { getViewerStoreApi, useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { collectIfcBuildingStoreyElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import { openIfcFileDialog } from '@/services/file-dialog';
import { logToDesktopTerminal } from '@/services/desktop-logger';
import { cacheFileBlobs, formatFileSize, getCachedFile, getRecentFiles, recordRecentFiles, type RecentFileEntry } from '@/lib/recent-files';
import { isTauri } from '@/lib/platform';
import { Upload, MousePointer, Layers, Info, Command, AlertTriangle, ChevronDown, ExternalLink, Plus, Clock3 } from 'lucide-react';
import type { MeshData, CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { type IfcDataStore } from '@ifc-lite/parser';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef';

const ZERO_VEC3 = { x: 0, y: 0, z: 0 };
const DEFAULT_COORDINATE_INFO: CoordinateInfo = {
  originShift: ZERO_VEC3,
  originalBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  shiftedBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  hasLargeCoordinates: false,
};

export function ViewportContainer() {
  const { loadFile, loading, clearAllModels, loadFilesSequentially } = useIfc();
  const releaseGeometryMemory = useViewerStore((s) => s.releaseGeometryMemory);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const resetViewerState = useViewerStore((s) => s.resetViewerState);
  const bcfOverlayVisible = useViewerStore((s) => s.bcfOverlayVisible);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const setCesiumSourceModelId = useViewerStore((s) => s.setCesiumSourceModelId);
  const setCesiumAvailable = useViewerStore((s) => s.setCesiumAvailable);
  // Subscribe to mutationVersion so Cesium reacts to georef edits
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const webgpu = useWebGPU();

  const viewerStoreApi = getViewerStoreApi();
  const viewportStoreState = useSyncExternalStore(
    viewerStoreApi.subscribe,
    viewerStoreApi.getState,
    viewerStoreApi.getState,
  );

  const {
    geometryResult,
    ifcDataStore,
    models,
    boundedGeometryMode,
    geometryUpdateTick,
  } = viewportStoreState;
  const storeModels = models;

  // Check if we have models loaded (for determining add vs replace behavior)
  const hasModelsLoaded = models.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);

  // Multi-model: create mapping from modelId to modelIndex (stable order)
  const modelIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const modelId of storeModels.keys()) {
      map.set(modelId, index++);
    }
    return map;
  }, [storeModels]);

  const mergedCacheRef = useRef<MeshData[]>([]);
  const mergedLengthsRef = useRef<Map<string, number>>(new Map());
  const mergedVisibilityRef = useRef<Map<string, boolean>>(new Map());

  // Multi-model: merge geometries from all visible models
  const mergedGeometryResult = useMemo(() => {
    if (storeModels.size === 1) {
      const firstModel = storeModels.values().next().value;
      if (!firstModel?.visible) {
        return {
          meshes: [],
          totalVertices: 0,
          totalTriangles: 0,
          coordinateInfo: DEFAULT_COORDINATE_INFO,
        } satisfies GeometryResult;
      }
      return firstModel.geometryResult ?? geometryResult;
    }

    if (storeModels.size > 1) {
      let totalVertices = 0;
      let totalTriangles = 0;
      let mergedCoordinateInfo: CoordinateInfo | undefined;
      let shouldRebuild = false;

      if (mergedLengthsRef.current.size !== storeModels.size) {
        shouldRebuild = true;
      }

      for (const [modelId, model] of storeModels) {
        const modelGeometry = model.geometryResult;
        const meshCount = model.visible ? (modelGeometry?.meshes.length ?? 0) : 0;
        totalVertices += model.visible ? (modelGeometry?.totalVertices ?? 0) : 0;
        totalTriangles += model.visible ? (modelGeometry?.totalTriangles ?? 0) : 0;
        if (!mergedCoordinateInfo && model.visible && modelGeometry?.coordinateInfo) {
          mergedCoordinateInfo = modelGeometry.coordinateInfo;
        }

        if (
          mergedVisibilityRef.current.get(modelId) !== model.visible ||
          (mergedLengthsRef.current.get(modelId) ?? 0) > meshCount
        ) {
          shouldRebuild = true;
        }
      }

      if (shouldRebuild) {
        const rebuilt: MeshData[] = [];
        mergedLengthsRef.current = new Map();
        mergedVisibilityRef.current = new Map();
        for (const [modelId, model] of storeModels) {
          const modelGeometry = model.geometryResult;
          mergedVisibilityRef.current.set(modelId, model.visible);
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          if (!model.visible || !modelGeometry?.meshes) {
            mergedLengthsRef.current.set(modelId, 0);
            continue;
          }
          for (const mesh of modelGeometry.meshes) {
            rebuilt.push({ ...mesh, modelIndex });
          }
          mergedLengthsRef.current.set(modelId, modelGeometry.meshes.length);
        }
        mergedCacheRef.current = rebuilt;
      } else {
        for (const [modelId, model] of storeModels) {
          const modelGeometry = model.geometryResult;
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          const previousLength = mergedLengthsRef.current.get(modelId) ?? 0;
          const nextMeshes = model.visible ? (modelGeometry?.meshes ?? []) : [];
          for (let i = previousLength; i < nextMeshes.length; i++) {
            const mesh = nextMeshes[i];
            mergedCacheRef.current.push({ ...mesh, modelIndex });
          }
          mergedLengthsRef.current.set(modelId, nextMeshes.length);
          mergedVisibilityRef.current.set(modelId, model.visible);
        }
      }

      return {
        meshes: mergedCacheRef.current,
        totalVertices,
        totalTriangles,
        coordinateInfo: mergedCoordinateInfo ?? DEFAULT_COORDINATE_INFO,
      } satisfies GeometryResult;
    }

    // Legacy mode (no federation): use original geometryResult
    return geometryResult;
  }, [storeModels, geometryResult, modelIdToIndex]);

  // Extract georeferencing info merged with any live mutations (for Cesium overlay).
  // Reacts to: model load, Cesium toggle, and every georef field edit.
  const georef = useMemo(() => {
    if (!cesiumEnabled) return null;

    // Check federated models first
    for (const [modelId, model] of storeModels) {
      const ds = model.ifcDataStore;
      if (!ds) continue;
      const effective = getEffectiveGeoreference(
        ds as IfcDataStore,
        model.geometryResult?.coordinateInfo,
        georefMutations.get(modelId),
      );
      if (effective?.projectedCRS?.name && effective.mapConversion) {
        return { ...effective, sourceModelId: modelId };
      }
    }

    // Fallback to legacy single-model
    if (ifcDataStore) {
      const effective = getEffectiveGeoreference(
        ifcDataStore as IfcDataStore,
        mergedGeometryResult?.coordinateInfo,
        georefMutations.get('__legacy__'),
      );
      if (effective?.projectedCRS?.name && effective.mapConversion) {
        return { ...effective, sourceModelId: '__legacy__' };
      }
    }

    return null;
  }, [cesiumEnabled, storeModels, ifcDataStore, georefMutations, mutationVersion, mergedGeometryResult]);

  // Determine whether Cesium button should be visible (model has georef or user added it via mutations).
  // Runs independently of cesiumEnabled so the button appears/disappears reactively.
  useEffect(() => {
    function hasGeoref(): boolean {
      // Check federated models
      for (const [modelId, model] of storeModels) {
        const ds = model.ifcDataStore;
        if (!ds) continue;
        const effective = getEffectiveGeoreference(
          ds as IfcDataStore,
          model.geometryResult?.coordinateInfo,
          georefMutations.get(modelId),
        );
        if (effective?.projectedCRS?.name) return true;
      }
      // Fallback to legacy single-model
      if (ifcDataStore) {
        const effective = getEffectiveGeoreference(
          ifcDataStore as IfcDataStore,
          mergedGeometryResult?.coordinateInfo,
          georefMutations.get('__legacy__'),
        );
        if (effective?.projectedCRS?.name) return true;
      }
      return false;
    }
    setCesiumAvailable(hasGeoref());
  }, [storeModels, ifcDataStore, georefMutations, mutationVersion, setCesiumAvailable, mergedGeometryResult]);

  // Sync the active Cesium source model ID so terrain actions are scoped correctly
  useEffect(() => {
    setCesiumSourceModelId(georef?.sourceModelId ?? null);
  }, [georef?.sourceModelId, setCesiumSourceModelId]);

  useEffect(() => {
    // Recent files are a desktop-only feature — the web viewer should not
    // show previously opened files in the landing page empty state.
    if (!isTauri()) return;

    const refreshRecentFiles = () => {
      setRecentFiles(getRecentFiles().slice(0, 3));
    };

    refreshRecentFiles();
    window.addEventListener('focus', refreshRecentFiles);
    return () => window.removeEventListener('focus', refreshRecentFiles);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show drag state if WebGPU is supported
    if (webgpu.supported) {
      setIsDragging(true);
    }
  }, [webgpu.supported]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    // Block file loading if WebGPU not supported
    if (!webgpu.supported) {
      return;
    }

    // Filter to supported files (IFC, IFCX, GLB)
    const supportedFiles = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith('.ifc') || f.name.endsWith('.ifcx') || f.name.endsWith('.glb')
    );

    if (supportedFiles.length === 0) return;

    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    setRecentFiles(getRecentFiles().slice(0, 3));

    if (hasModelsLoaded) {
      // Models already loaded - add new files sequentially
      loadFilesSequentially(supportedFiles);
    } else if (supportedFiles.length === 1) {
      // Single file, no models loaded - use loadFile
      loadFile(supportedFiles[0]);
    } else {
      // Multiple files, no models loaded - use federation
      resetViewerState();
      clearAllModels();
      loadFilesSequentially(supportedFiles);
    }
  }, [loadFile, loadFilesSequentially, resetViewerState, clearAllModels, webgpu.supported, hasModelsLoaded]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Block file loading if WebGPU not supported
    if (!webgpu.supported) {
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB)
    const supportedFiles = Array.from(files).filter(
      f => f.name.endsWith('.ifc') || f.name.endsWith('.ifcx') || f.name.endsWith('.glb')
    );

    if (supportedFiles.length === 0) return;

    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    setRecentFiles(getRecentFiles().slice(0, 3));

    if (supportedFiles.length === 1) {
      // Single file - use loadFile (simpler single-model path)
      loadFile(supportedFiles[0]);
    } else {
      // Multiple files selected - use federation from the start
      // Clear everything and start fresh, then load sequentially
      resetViewerState();
      clearAllModels();
      loadFilesSequentially(supportedFiles);
    }

    // Reset input so same file can be selected again
    e.target.value = '';
  }, [loadFile, loadFilesSequentially, resetViewerState, clearAllModels, webgpu.supported]);

  const hasGeometry = mergedGeometryResult?.meshes && mergedGeometryResult.meshes.length > 0;

  // Check if any models are loaded (even if hidden) - used to show empty 3D vs starting UI
  const hasLoadedModels = storeModels.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);

  // PERF: Incremental geometry filtering using refs.
  // Instead of creating a new 200K+ element array every batch (~200ms),
  // we push ONLY new meshes into a cached array — O(batch_size) not O(total).
  // A version counter triggers downstream re-renders via the Viewport prop.
  const filteredCacheRef = useRef<MeshData[]>([]);
  const filteredSourceLenRef = useRef(0);
  const filteredSourceRef = useRef<MeshData[] | null>(null);
  const filteredTypeVisRef = useRef(typeVisibility);
  const filteredVersionRef = useRef(0);

  const filteredGeometry = useMemo(() => {
    if (!mergedGeometryResult?.meshes) {
      filteredCacheRef.current = [];
      filteredSourceLenRef.current = 0;
      filteredSourceRef.current = null;
      filteredVersionRef.current = 0;
      return null;
    }

    const allMeshes = mergedGeometryResult.meshes;
    const cache = filteredCacheRef.current;

    // Full rebuild if: type visibility changed, source shrunk (new file), or empty cache
    const prevVis = filteredTypeVisRef.current;
    const typeVisChanged =
      prevVis.spaces !== typeVisibility.spaces ||
      prevVis.openings !== typeVisibility.openings ||
      prevVis.site !== typeVisibility.site;
    const sourceChanged = filteredSourceRef.current !== allMeshes;
    if (typeVisChanged || sourceChanged || allMeshes.length < filteredSourceLenRef.current) {
      cache.length = 0;
      filteredSourceLenRef.current = 0;
      filteredSourceRef.current = allMeshes;
      filteredTypeVisRef.current = typeVisibility;
    }

    const needsFilter = !typeVisibility.spaces || !typeVisibility.openings || !typeVisibility.site;
    const prevCacheLen = cache.length;

    // Only process NEW meshes since last run — O(batch_size) not O(total)
    for (let i = filteredSourceLenRef.current; i < allMeshes.length; i++) {
      const mesh = allMeshes[i];
      const ifcType = mesh.ifcType;

      if (needsFilter) {
        if (ifcType === 'IfcSpace' && !typeVisibility.spaces) continue;
        if (ifcType === 'IfcOpeningElement' && !typeVisibility.openings) continue;
        if (ifcType === 'IfcSite' && !typeVisibility.site) continue;
      }

      if (ifcType === 'IfcSpace' || ifcType === 'IfcOpeningElement') {
        cache.push({
          ...mesh,
          color: [mesh.color[0], mesh.color[1], mesh.color[2], Math.min(mesh.color[3] * 0.3, 0.3)],
        });
      } else {
        cache.push(mesh);
      }
    }

    filteredSourceLenRef.current = allMeshes.length;

    // Only bump version when cache content actually changed — avoids
    // unnecessary downstream re-renders when memo runs with same data.
    if (cache.length !== prevCacheLen || typeVisChanged || sourceChanged) {
      filteredVersionRef.current++;
    }

    // Return the same array reference — downstream change detection uses
    // geometryVersion (which increments each batch) instead of array identity.
    return cache;
  }, [mergedGeometryResult, typeVisibility]);

  // Version counter that changes every batch — triggers useGeometryStreaming
  // without requiring a new geometry array reference.
  const geometryVersion = filteredVersionRef.current;

  // Compute combined isolation set (storeys + manual isolation)
  // This is passed to the renderer for batch-level visibility filtering
  // Now supports multi-model: aggregates elements from all models for selected storeys
  // IMPORTANT: Returns globalIds (meshes use globalIds after federation registry transformation)
  const computedIsolatedIds = useMemo(() => {
    // Compute storey isolation if storeys are selected
    let storeyIsolation: Set<number> | null = null;
    if (selectedStoreys.size > 0) {
      const combinedGlobalIds = new Set<number>();

      // Check each federated model's storeys
      for (const [, model] of storeModels) {
        const hierarchy = model.ifcDataStore?.spatialHierarchy;
        if (!hierarchy) continue;

        for (const storeyId of selectedStoreys) {
          const localStoreyId = hierarchy.byStorey.has(storeyId)
            ? storeyId
            : storeyId - (model.idOffset ?? 0);
          const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, localStoreyId);
          if (storeyElementIds) {
            for (const originalExpressId of storeyElementIds) {
              combinedGlobalIds.add(toGlobalIdFromModels(storeModels, model.id, originalExpressId));
            }
          }
        }
      }

      // Legacy single-model mode (offset = 0)
      if (ifcDataStore?.spatialHierarchy && storeModels.size === 0) {
        const hierarchy = ifcDataStore.spatialHierarchy;
        for (const storeyId of selectedStoreys) {
          const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, storeyId);
          if (storeyElementIds) {
            for (const id of storeyElementIds) {
              combinedGlobalIds.add(id);
            }
          }
        }
      }

      if (combinedGlobalIds.size > 0) {
        storeyIsolation = combinedGlobalIds;
      }
    }

    // Collect all active filters and intersect them
    const filters: Set<number>[] = [];
    if (storeyIsolation !== null) filters.push(storeyIsolation);
    if (classFilter !== null) filters.push(classFilter.ids);
    if (isolatedEntities !== null) filters.push(isolatedEntities);

    if (filters.length === 0) return null;
    if (filters.length === 1) return filters[0];

    // Intersect all active filters — start from smallest for efficiency
    const sorted = filters.sort((a, b) => a.size - b.size);
    const intersection = new Set<number>();
    for (const id of sorted[0]) {
      if (sorted.every(s => s.has(id))) {
        intersection.add(id);
      }
    }
    return intersection;
  }, [storeModels, ifcDataStore, selectedStoreys, isolatedEntities, classFilter]);

  // Grid Pattern
  const GridPattern = () => (
    <>
      {/* Light mode grid - subtle gray */}
      <div 
        className="absolute inset-0 z-0 pointer-events-none opacity-[0.06] dark:hidden"
        style={{
          backgroundImage: `linear-gradient(#3b4261 1px, transparent 1px), linear-gradient(90deg, #3b4261 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          backgroundPosition: '-1px -1px'
        }}
      />
      {/* Dark mode grid - subtle blue/cyan tint */}
      <div 
        className="absolute inset-0 z-0 pointer-events-none opacity-[0.12] hidden dark:block"
        style={{
          backgroundImage: `linear-gradient(#3b4261 1px, transparent 1px), linear-gradient(90deg, #3b4261 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          backgroundPosition: '-1px -1px'
        }}
      />
    </>
  );

  // Empty state when no file is loaded at all (show starting UI)
  // But NOT when models are loaded but just hidden - in that case show empty 3D canvas
  if (!hasLoadedModels && !loading) {
    return (
      <div
        className="relative h-full w-full bg-white dark:bg-black text-zinc-900 dark:text-zinc-50 overflow-hidden"
        data-viewport
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <GridPattern />

        <input
          ref={fileInputRef}
          type="file"
          accept=".ifc,.ifcx,.glb"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center p-8">
            <div className="border-4 border-dashed border-primary bg-white/90 dark:bg-black/90 p-12 max-w-2xl w-full text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] transition-all">
              <Upload className="h-20 w-20 mx-auto text-primary mb-6" />
              <p className="text-3xl font-black uppercase tracking-tight text-primary">Drop File to Load</p>
            </div>
          </div>
        )}

        {/* WebGPU Not Supported Banner */}
        {!webgpu.checking && !webgpu.supported && (
          <div className="absolute top-0 left-0 right-0 z-40">
            {/* Hazard stripes background */}
            <div
              className="absolute inset-0 opacity-10"
              style={{
                backgroundImage: `repeating-linear-gradient(
                  -45deg,
                  transparent,
                  transparent 10px,
                  #f7768e 10px,
                  #f7768e 20px
                )`
              }}
            />
            <div className="relative border-b-4 border-[#f7768e] bg-[#1a1b26] dark:bg-[#1a1b26] px-4 py-5">
              <div className="max-w-3xl mx-auto flex items-start gap-4">
                {/* Icon container with brutalist frame */}
                <div className="flex-shrink-0 border-2 border-[#f7768e] p-2 bg-[#f7768e]/10">
                  <AlertTriangle className="h-6 w-6 text-[#f7768e]" />
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-black text-lg uppercase tracking-wider text-[#f7768e] mb-1">
                    WebGPU Not Available
                  </h3>
                  <p className="font-mono text-sm text-[#a9b1d6] leading-relaxed">
                    This viewer requires WebGPU which is not supported by your browser or device.
                    {webgpu.reason && (
                      <span className="block mt-1 text-[#565f89]">
                        {webgpu.reason}
                      </span>
                    )}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      href="https://caniuse.com/webgpu"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono uppercase tracking-wide border border-[#3b4261] text-[#7aa2f7] hover:border-[#7aa2f7] hover:bg-[#7aa2f7]/10 transition-colors"
                    >
                      Check Browser Support
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="inline-flex items-center px-3 py-1 text-xs font-mono text-[#565f89] border border-[#3b4261]">
                      Chrome 113+ / Edge 113+ / Firefox 141+ / Safari 18+
                    </span>
                  </div>

                  {/* Troubleshooting Section */}
                  <button
                    onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                    className="mt-4 flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-[#ff9e64] hover:text-[#e0af68] transition-colors"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showTroubleshooting ? 'rotate-180' : ''}`} />
                    {showTroubleshooting ? 'Hide' : 'Show'} Troubleshooting
                  </button>

                  {showTroubleshooting && (
                    <div className="mt-4 p-4 bg-[#1f2335] border border-[#3b4261] text-xs font-mono space-y-4">
                      <div>
                        <h4 className="font-bold text-[#ff9e64] uppercase tracking-wide mb-2">Blocklist Override</h4>
                        <p className="text-[#a9b1d6] mb-2">
                          WebGPU may be disabled due to GPU/driver blocklist. Try these flags:
                        </p>
                        <div className="space-y-1 text-[#7dcfff]">
                          <p><code className="bg-[#16161e] px-1.5 py-0.5">chrome://flags/#enable-unsafe-webgpu</code> → Enable</p>
                          <p><code className="bg-[#16161e] px-1.5 py-0.5">chrome://flags/#ignore-gpu-blocklist</code> → Enable</p>
                        </div>
                      </div>

                      <div>
                        <h4 className="font-bold text-[#bb9af7] uppercase tracking-wide mb-2">Firefox</h4>
                        <p className="text-[#a9b1d6] mb-2">
                          WebGPU enabled by default in Firefox 141+. For older versions:
                        </p>
                        <p className="text-[#7dcfff]">
                          <code className="bg-[#16161e] px-1.5 py-0.5">about:config</code> → <code className="bg-[#16161e] px-1.5 py-0.5">dom.webgpu.enabled</code> → true
                        </p>
                      </div>

                      <div>
                        <h4 className="font-bold text-[#9ece6a] uppercase tracking-wide mb-2">Safari</h4>
                        <p className="text-[#a9b1d6]">
                          Safari → Settings → Feature Flags → Enable "WebGPU"
                        </p>
                      </div>

                      <div>
                        <h4 className="font-bold text-[#7aa2f7] uppercase tracking-wide mb-2">Verify Status</h4>
                        <p className="text-[#a9b1d6] mb-2">Check your GPU status page:</p>
                        <div className="space-y-1 text-[#7dcfff]">
                          <p>Chrome/Edge: <code className="bg-[#16161e] px-1.5 py-0.5">chrome://gpu</code></p>
                          <p>Firefox: <code className="bg-[#16161e] px-1.5 py-0.5">about:support</code></p>
                        </div>
                      </div>

                      <a
                        href="https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[#7aa2f7] hover:underline"
                      >
                        Full Troubleshooting Guide
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-8 z-10">

          {/* Main Card */}
          <div className="max-w-md w-full bg-white dark:bg-[#16161e] border border-zinc-300 dark:border-[#3b4261] p-8 flex flex-col items-center transition-transform hover:-translate-y-1 duration-200 shadow-lg">
            
            <style>{`
              @keyframes float-slow {
                0%, 100% { transform: translateY(0px) rotate(0deg); }
                50% { transform: translateY(-6px) rotate(1deg); }
              }
              .animate-float-slow {
                animation: float-slow 5s ease-in-out infinite;
              }
            `}</style>

            {/* Logo Section */}
            <div className="mb-10 relative group/logo cursor-pointer">
              {/* Back Layer */}
              <div className="absolute -inset-6 bg-zinc-100 dark:bg-[#1f2335] -rotate-3 z-0 border border-zinc-300 dark:border-[#3b4261] transition-all duration-500 group-hover/logo:rotate-0 group-hover/logo:scale-110" />
              
              {/* Middle Layer - accent on hover */}
              <div className="absolute -inset-6 border border-primary z-0 opacity-0 scale-95 rotate-3 transition-all duration-500 delay-75 group-hover/logo:opacity-40 group-hover/logo:rotate-6 group-hover/logo:scale-105" />

              {/* Logo Container */}
              <div className="relative z-10 animate-float-slow transition-transform duration-300 group-hover/logo:scale-110">
                <img 
                  src="/logo.png" 
                  alt="IFClite Logo" 
                  className="h-28 w-auto drop-shadow-lg"
                />
              </div>
            </div>

            <h2 className="text-3xl font-black tracking-tighter text-center mb-2 text-zinc-900 dark:text-[#a9b1d6]">
              IFClite
            </h2>
            <p className="text-zinc-500 dark:text-[#565f89] font-mono text-sm text-center mb-8 border-b border-zinc-200 dark:border-[#3b4261] pb-4 w-full">
              High-performance web viewer demo
            </p>

            {/* Action */}
            <button
              onClick={async () => {
                if (!webgpu.supported) {
                  return;
                }

                void logToDesktopTerminal('info', '[ViewportContainer] Empty-state open button clicked');
                const file = await openIfcFileDialog();
                if (file) {
                  void logToDesktopTerminal('info', `[ViewportContainer] Native dialog selected ${file.path}`);
                  recordRecentFiles([{
                    name: file.name,
                    size: file.size,
                    path: file.path,
                    modifiedMs: file.modifiedMs ?? null,
                  }]);
                  setRecentFiles(getRecentFiles().slice(0, 3));
                  loadFile(file);
                  return;
                }

                void logToDesktopTerminal('info', '[ViewportContainer] Falling back to browser file input');
                fileInputRef.current?.click();
              }}
              disabled={!webgpu.supported || webgpu.checking}
              className={`group w-full flex items-center justify-center gap-3 px-6 py-3 font-mono text-sm border transition-all ${
                !webgpu.supported || webgpu.checking
                  ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
                  : 'border-zinc-300 dark:border-[#3b4261] text-zinc-600 dark:text-[#a9b1d6] hover:border-primary hover:text-primary cursor-pointer'
              }`}
            >
              <Upload className={`h-4 w-4 transition-transform ${webgpu.supported ? 'group-hover:-translate-y-0.5' : ''}`} />
              <span>{webgpu.checking ? 'Checking WebGPU...' : webgpu.supported ? 'Open .ifc file' : 'WebGPU Required'}</span>
            </button>

            <p className="mt-3 text-xs font-mono text-zinc-400 dark:text-[#565f89]">
              {webgpu.supported ? 'or drag & drop anywhere' : 'file upload disabled'}
            </p>

            {recentFiles.length > 0 && (
              <div className="mt-6 w-full border-t border-zinc-200 dark:border-[#3b4261] pt-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-zinc-400 dark:text-[#565f89]">
                  <Clock3 className="h-3.5 w-3.5" />
                  <span>Recent Files</span>
                </div>
                <div className="flex flex-col gap-2">
                  {recentFiles.map((file) => (
                    <button
                      key={`${file.name}-${file.timestamp}`}
                      type="button"
                      onClick={async () => {
                        const cached = await getCachedFile(file);
                        if (cached) {
                          await loadFile(cached);
                          return;
                        }
                        fileInputRef.current?.click();
                      }}
                      className="flex items-center justify-between gap-3 border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition-colors hover:border-primary hover:text-primary dark:border-[#3b4261] dark:bg-[#1f2335] dark:hover:border-primary"
                    >
                      <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-zinc-400 dark:text-[#565f89]">
                        {formatFileSize(file.size)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Feature Grid */}
          <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl w-full">
            {[
              { icon: MousePointer, label: "Select", desc: "Inspect elements", accentClass: 'text-blue-500 dark:text-[#7aa2f7]' },
              { icon: Layers, label: "Filter", desc: "Isolate storeys", accentClass: 'text-purple-500 dark:text-[#bb9af7]' },
              { icon: Info, label: "Analyze", desc: "View properties", accentClass: 'text-cyan-500 dark:text-[#7dcfff]' }
            ].map((feature, i) => (
              <div 
                key={i} 
                className="p-4 flex items-center gap-4 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261]"
              >
                <div className={`p-2 bg-white dark:bg-[#16161e] border border-zinc-300 dark:border-[#3b4261] ${feature.accentClass}`}>
                  <feature.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold uppercase text-sm tracking-wide text-zinc-900 dark:text-[#a9b1d6]">{feature.label}</h3>
                  <p className="text-xs font-mono text-zinc-500 dark:text-[#565f89]">{feature.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="absolute bottom-8 right-8 hidden md:block">
            <div className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#565f89]">
              <Command className="h-3 w-3" />
              <span>SHORTCUTS</span>
              <span className="px-1.5 ml-1 font-bold text-primary bg-primary/20">?</span>
            </div>
          </div>

        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full bg-zinc-50 dark:bg-black overflow-hidden"
      data-viewport
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay for when a file is already loaded - shows "Add Model" */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-[#9ece6a]/10 backdrop-blur-[2px] flex items-center justify-center">
          <div className="bg-white dark:bg-[#1a1b26] border-4 border-dashed border-[#9ece6a] p-8 shadow-2xl">
            <div className="text-center">
              <Plus className="h-12 w-12 mx-auto text-[#9ece6a] mb-4" />
              <p className="text-xl font-black uppercase text-[#9ece6a]">Add Model to Scene</p>
              <p className="text-sm font-mono text-zinc-500 dark:text-[#565f89] mt-2">
                Drop to federate with {models.size} existing model{models.size !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Cesium 3D world context overlay — rendered behind the WebGPU canvas (web only) */}
      {cesiumEnabled && georef && !isTauri() && (
        <CesiumOverlay
          mapConversion={georef.mapConversion}
          projectedCRS={georef.projectedCRS}
          coordinateInfo={georef.coordinateInfo}
          geometryResult={mergedGeometryResult}
          lengthUnitScale={georef.lengthUnitScale}
        />
      )}
      <Viewport
        geometry={filteredGeometry}
        geometryVersion={geometryVersion}
        coordinateInfo={mergedGeometryResult?.coordinateInfo}
        computedIsolatedIds={computedIsolatedIds}
        modelIdToIndex={modelIdToIndex}
        cesiumActive={cesiumEnabled && georef !== null && !isTauri()}
        releaseGeometryAfterStream={false}
        onGeometryReleased={releaseGeometryMemory}
      />
      {bcfOverlayVisible && <BCFOverlay />}
      <ViewportOverlays />
      <ToolOverlays />
      <BasketPresentationDock />
      <Section2DPanel
        mergedGeometry={mergedGeometryResult}
        computedIsolatedIds={computedIsolatedIds}
        modelIdToIndex={modelIdToIndex}
      />
    </div>
  );
}
