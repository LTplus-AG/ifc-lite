/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLevelDisplayEffect } from '@/hooks/useLevelDisplayEffect';
import { Viewport } from './Viewport';
import {
  initialDragOverlayState,
  reduceDragOverlay,
  type DragOverlayEvent,
  type DragOverlayState,
} from './dragOverlayState';
import { ViewportOverlays } from './ViewportOverlays';
import { MergeLayersBanner } from './MergeLayersBanner';
import { GeometryModeBanner } from './GeometryModeBanner';
import { LevelDisplayIndicator } from './LevelDisplayIndicator';
import { ToolOverlays } from './ToolOverlays';
import { AnnotationLayer } from './annotations/AnnotationLayer';
import { CollabPresenceLayer } from './CollabPresenceLayer';
import { Section2DPanel } from './Section2DPanel';
import { BasketPresentationDock } from './BasketPresentationDock';
import { BCFOverlay } from './bcf/BCFOverlay';
import { CesiumOverlay } from './CesiumOverlay';
import { CesiumPlacementEditor } from './CesiumPlacementEditor';
import { SunSkyPanel } from './SunSkyPanel';
import { SpaceMousePanel } from './SpaceMousePanel';
import { useSolarEnvironment } from '@/hooks/useSolarEnvironment';
import { useSolarSweep } from '@/hooks/useSolarSweep';
import { getViewerStoreApi, useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { collectIfcBuildingStoreyElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import type { AggregationRelationships } from '@/utils/aggregation';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import { cacheFileBlobs, formatFileSize, getCachedFile, getRecentFiles, recordRecentFiles, type RecentFileEntry } from '@/lib/recent-files';
import {
  supportsFileSystemAccess,
  openIfcFilesWithHandles,
  handlesFromDataTransfer,
} from '@/services/file-system-access';
import { toast } from '@/components/ui/toast';
import { TourInvite } from '@/components/tours/TourInvite';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { describeUnsupportedFormat } from '@/hooks/ingest/pointCloudIngest';
import { Upload, MousePointer, Layers, Info, Command, AlertTriangle, ChevronDown, ExternalLink, Plus, Clock3, Sparkles, ArrowUpRight, PackagePlus } from 'lucide-react';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import type { MeshData, CoordinateInfo, GeometryResult, PointCloudAsset } from '@ifc-lite/geometry';
import { type IfcDataStore, type MapConversion } from '@ifc-lite/parser';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef';
import { isMeshVisibleInViewMode, meshClassIsPlaced } from '@/lib/type-view-visibility';

const ZERO_VEC3 = { x: 0, y: 0, z: 0 };
const DEFAULT_COORDINATE_INFO: CoordinateInfo = {
  originShift: ZERO_VEC3,
  originalBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  shiftedBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  hasLargeCoordinates: false,
};

type Vec3Bounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** True for a real (non-placeholder, non-degenerate) bounds box. */
function isUsableBounds(b: Vec3Bounds | undefined): b is Vec3Bounds {
  if (!b) return false;
  return (
    b.max.x > b.min.x || b.max.y > b.min.y || b.max.z > b.min.z
  );
}

/** Axis-aligned union of two bounds boxes (either may be undefined). */
function unionBounds(acc: Vec3Bounds | undefined, b: Vec3Bounds | undefined): Vec3Bounds | undefined {
  if (!isUsableBounds(b)) return acc;
  if (!acc) return { min: { ...b.min }, max: { ...b.max } };
  return {
    min: { x: Math.min(acc.min.x, b.min.x), y: Math.min(acc.min.y, b.min.y), z: Math.min(acc.min.z, b.min.z) },
    max: { x: Math.max(acc.max.x, b.max.x), y: Math.max(acc.max.y, b.max.y), z: Math.max(acc.max.z, b.max.z) },
  };
}

export function ViewportContainer() {
  // Drive Stacked / Solo / Exploded level display from the slice.
  // Mount-once hook — it self-gates on mode + gap + model changes.
  useLevelDisplayEffect();

  const { loadFile, loading, clearAllModels, loadFilesSequentially } = useIfc();
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const releaseGeometryMemory = useViewerStore((s) => s.releaseGeometryMemory);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const typeViewMode = useViewerStore((s) => s.typeViewMode);
  const setHasTypeGeometry = useViewerStore((s) => s.setHasTypeGeometry);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const resetViewerState = useViewerStore((s) => s.resetViewerState);
  const bcfOverlayVisible = useViewerStore((s) => s.bcfOverlayVisible);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const cesiumPlacementDraft = useViewerStore((s) => s.cesiumPlacementDraft);
  const cesiumPlacementDraftModelId = useViewerStore((s) => s.cesiumPlacementDraftModelId);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
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
    geometryContentVersion,
  } = viewportStoreState;
  const storeModels = models;
  const mergedContentVersionRef = useRef(geometryContentVersion);

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
      // The merged coordinateInfo must cover ALL visible models, not just the
      // first one — the renderer fits the camera to `shiftedBounds`, so a
      // first-wins box left every model after the first off-screen (it only
      // showed its 2D grid overlay). Union the bounds across visible models;
      // keep the first model's frame metadata (originShift / RTC) since
      // federated models share a coordinate frame.
      let baseCoordInfo: CoordinateInfo | undefined;
      let unionedShifted: Vec3Bounds | undefined;
      let unionedOriginal: Vec3Bounds | undefined;
      let anyLargeCoords = false;
      let shouldRebuild = false;

      if (mergedLengthsRef.current.size !== storeModels.size) {
        shouldRebuild = true;
      }

      // An external content version bump (e.g. realignFederation re-baked
      // vertices in place) requires a full cache rebuild — length/visibility
      // triggers above can't detect in-place mutation. Compare against the
      // last version we honoured; rebuild when it bumps.
      if (mergedContentVersionRef.current !== geometryContentVersion) {
        shouldRebuild = true;
        mergedContentVersionRef.current = geometryContentVersion;
      }

      for (const [modelId, model] of storeModels) {
        const modelGeometry = model.geometryResult;
        const meshCount = model.visible ? (modelGeometry?.meshes.length ?? 0) : 0;
        totalVertices += model.visible ? (modelGeometry?.totalVertices ?? 0) : 0;
        totalTriangles += model.visible ? (modelGeometry?.totalTriangles ?? 0) : 0;
        if (model.visible && modelGeometry?.coordinateInfo) {
          const ci = modelGeometry.coordinateInfo;
          if (!baseCoordInfo) baseCoordInfo = ci;
          anyLargeCoords = anyLargeCoords || !!ci.hasLargeCoordinates;
          unionedShifted = unionBounds(unionedShifted, ci.shiftedBounds);
          unionedOriginal = unionBounds(unionedOriginal, ci.originalBounds);
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

      const mergedCoordinateInfo: CoordinateInfo | undefined = baseCoordInfo
        ? {
            ...baseCoordInfo,
            originalBounds: unionedOriginal ?? baseCoordInfo.originalBounds,
            shiftedBounds: unionedShifted ?? baseCoordInfo.shiftedBounds,
            hasLargeCoordinates: anyLargeCoords,
          }
        : undefined;

      return {
        meshes: mergedCacheRef.current,
        totalVertices,
        totalTriangles,
        coordinateInfo: mergedCoordinateInfo ?? DEFAULT_COORDINATE_INFO,
      } satisfies GeometryResult;
    }

    // Legacy mode (no federation): use original geometryResult
    return geometryResult;
  }, [storeModels, geometryResult, modelIdToIndex, geometryContentVersion]);

  /**
   * Aggregate point clouds across visible models.
   *
   * Phase 0: identity-stamping with modelIndex. Returns the same array
   * reference when nothing has changed so the consumer effect skips work.
   */
  const mergedPointClouds = useMemo(() => {
    const collected: PointCloudAsset[] = [];
    if (storeModels.size > 0) {
      for (const [modelId, model] of storeModels) {
        if (!model.visible) continue;
        const assets = model.geometryResult?.pointClouds;
        if (!assets || assets.length === 0) continue;
        const modelIndex = modelIdToIndex.get(modelId) ?? 0;
        for (const asset of assets) {
          // Scan-based terrain is stamped `IfcGeographicElement`; honour the
          // same type-visibility gate as the mesh path so the Site toggle hides
          // it too (issue #1480).
          if (!isTypeVisible(asset.ifcType, typeVisibility)) continue;
          collected.push(asset.modelIndex === modelIndex ? asset : { ...asset, modelIndex });
        }
      }
    } else if (geometryResult?.pointClouds) {
      for (const asset of geometryResult.pointClouds) {
        if (!isTypeVisible(asset.ifcType, typeVisibility)) continue;
        collected.push(asset);
      }
    }
    return collected;
  }, [storeModels, geometryResult, modelIdToIndex, typeVisibility]);

  // Extract georeferencing info merged with any live mutations (for Cesium overlay).
  // Reacts to: model load, Cesium toggle, and every georef field edit.
  // Also computed while the solar study runs without Cesium — the WebGPU sun
  // needs the site's lat/lon + map rotation to track the studied instant.
  const georef = useMemo(() => {
    if (!cesiumEnabled && !solarEnabled) return null;

    const applyPlacementDraft = <T extends { mapConversion?: MapConversion }>(
      modelId: string,
      effective: T,
    ): T & { baseMapConversion?: T['mapConversion'] } => {
      const preview = cesiumPlacementDraftModelId === modelId ? cesiumPlacementDraft : null;
      if (!preview || !effective.mapConversion) {
        return {
          ...effective,
          baseMapConversion: effective.mapConversion,
        };
      }
      return {
        ...effective,
        baseMapConversion: effective.mapConversion,
        mapConversion: {
          ...effective.mapConversion,
          ...preview,
        },
      };
    };

    // Check federated models, preferring the user-pinned anchor when present.
    // Matches findReferenceGeorefModel() in useIfcFederation so the Cesium bridge
    // and the parse-time alignment agree on which model drives the world frame.
    //
    // The ungated `selectAnchorGeoref` (lib/geo/useAnchorGeoreference) shares this
    // "pinned anchor, else first model with a usable map-conversion georef"
    // selection for the basepoint overlay and the measure-tool XYZ readout. This
    // memo stays bespoke on purpose: it is gated on Cesium/solar, iterates in the
    // store's insertion order (not loadedAt), and layers the placement-draft
    // preview + storey elevations that only the Cesium bridge consumes.
    const orderedModels = (() => {
      if (!anchorModelIdOverride) return Array.from(storeModels);
      const entries = Array.from(storeModels);
      const anchorIdx = entries.findIndex(([id]) => id === anchorModelIdOverride);
      if (anchorIdx <= 0) return entries;
      const reordered = [entries[anchorIdx], ...entries.slice(0, anchorIdx), ...entries.slice(anchorIdx + 1)];
      return reordered;
    })();
    for (const [modelId, model] of orderedModels) {
      const ds = model.ifcDataStore;
      if (!ds) continue;
      const effective = getEffectiveGeoreference(
        ds as IfcDataStore,
        model.geometryResult?.coordinateInfo,
        georefMutations.get(modelId),
      );
      if (
        effective?.projectedCRS?.name
        && effective.mapConversion
        && effective.source !== 'siteLocation'
      ) {
        const previewed = applyPlacementDraft(modelId, effective);
        return {
          ...previewed,
          sourceModelId: modelId,
          storeyElevations: ds.spatialHierarchy?.storeyElevations,
        };
      }
    }

    // Fallback to legacy single-model
    if (ifcDataStore) {
      const effective = getEffectiveGeoreference(
        ifcDataStore as IfcDataStore,
        mergedGeometryResult?.coordinateInfo,
        georefMutations.get('__legacy__'),
      );
      if (
        effective?.projectedCRS?.name
        && effective.mapConversion
        && effective.source !== 'siteLocation'
      ) {
        const previewed = applyPlacementDraft('__legacy__', effective);
        return {
          ...previewed,
          sourceModelId: '__legacy__',
          storeyElevations: ifcDataStore.spatialHierarchy?.storeyElevations,
        };
      }
    }

    return null;
  }, [
    cesiumEnabled,
    solarEnabled,
    storeModels,
    ifcDataStore,
    georefMutations,
    mutationVersion,
    // Only the (stable) coordinateInfo is read here, not the whole result —
    // depending on `mergedGeometryResult` re-runs this on every streamed
    // geometry batch, re-triggering the property-set georef scan each time.
    mergedGeometryResult?.coordinateInfo,
    cesiumPlacementDraft,
    cesiumPlacementDraftModelId,
    anchorModelIdOverride,
  ]);

  // Feed the solar study's sun position into the WebGPU lighting environment
  // (viewer-space sun direction + panel readout when Cesium is off).
  useSolarEnvironment(georef);
  // Sweep animation runs here so collapsing/closing the panel doesn't stop it.
  useSolarSweep();

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
        if (effective?.projectedCRS?.name && effective.source !== 'siteLocation') return true;
      }
      // Fallback to legacy single-model
      if (ifcDataStore) {
        const effective = getEffectiveGeoreference(
          ifcDataStore as IfcDataStore,
          mergedGeometryResult?.coordinateInfo,
          georefMutations.get('__legacy__'),
        );
        if (effective?.projectedCRS?.name && effective.source !== 'siteLocation') return true;
      }
      return false;
    }
    setCesiumAvailable(hasGeoref());
    // Depend on the stable coordinateInfo, not the whole mergedGeometryResult:
    // the latter gets a new reference each streamed batch, which would re-run
    // this georef property-set scan ~once per batch on large models.
  }, [storeModels, ifcDataStore, georefMutations, mutationVersion, setCesiumAvailable, mergedGeometryResult?.coordinateInfo]);

  // Sync the active Cesium source model ID so terrain actions are scoped correctly
  useEffect(() => {
    setCesiumSourceModelId(georef?.sourceModelId ?? null);
  }, [georef?.sourceModelId, setCesiumSourceModelId]);

  // Track drag enter/leave depth so the overlay doesn't flicker when the
  // cursor moves between child elements (each child boundary fires its own
  // dragenter/dragleave that bubbles to the container). See dragOverlayState.ts.
  const dragStateRef = useRef<DragOverlayState>(initialDragOverlayState);

  const applyDragEvent = useCallback((event: DragOverlayEvent) => {
    dragStateRef.current = reduceDragOverlay(dragStateRef.current, event, webgpu.supported);
    setIsDragging(dragStateRef.current.dragging);
  }, [webgpu.supported]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    applyDragEvent('enter');
  }, [applyDragEvent]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Needed to allow the drop, but does not toggle drag state (avoids flicker)
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    applyDragEvent('leave');
  }, [applyDragEvent]);

  const isSupportedFile = useCallback((f: File) => {
    const n = f.name.toLowerCase();
    return n.endsWith('.ifc') || n.endsWith('.ifcx') || n.endsWith('.ifczip') || n.endsWith('.glb')
      || n.endsWith('.las') || n.endsWith('.laz') || n.endsWith('.ply') || n.endsWith('.pcd')
      || n.endsWith('.e57') || n.endsWith('.pts') || n.endsWith('.xyz');
  }, []);

  // Single routing point for every ingestion path (picker / drop / input). The
  // optional `handles` array is positionally aligned with `files` and carries a
  // live FS Access handle per file when one was captured (Chromium) so the model
  // stays refreshable; entries are `undefined` otherwise.
  const routeLoad = useCallback((
    files: File[],
    handles?: (FileSystemFileHandle | undefined)[],
  ) => {
    if (hasModelsLoaded) {
      // Models already loaded - add new files sequentially (federate).
      void loadFilesSequentially(files, handles);
    } else if (files.length === 1) {
      // Single file, no models loaded - primary single-model load.
      void loadFile(files[0], { kind: 'primary' }, { sourceHandle: handles?.[0] });
    } else {
      // Multiple files, no models loaded - start a fresh federation.
      resetViewerState();
      clearAllModels();
      void loadFilesSequentially(files, handles);
    }
  }, [loadFile, loadFilesSequentially, resetViewerState, clearAllModels, hasModelsLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    applyDragEvent('drop');

    // Block file loading if WebGPU not supported
    if (!webgpu.supported) {
      return;
    }

    // Capture live handles synchronously — the DataTransferItemList is neutered
    // once this handler returns, so this must run before any await.
    const handlesPromise = handlesFromDataTransfer(e.dataTransfer);

    // Filter to supported files (IFC, IFCX, GLB, point clouds)
    const allDropped = Array.from(e.dataTransfer.files);
    const supportedFiles = allDropped.filter(isSupportedFile);

    if (supportedFiles.length === 0) {
      // Tell the user *why* — common case is a Recap project / SketchUp
      // file dropped because they assumed our viewer would understand it.
      const explained = allDropped.find((f) => describeUnsupportedFormat(f.name));
      if (explained) {
        toast.error(`${explained.name}: ${describeUnsupportedFormat(explained.name)}`);
      }
      return;
    }

    void handlesPromise.then((opened) => {
      // Prefer the handle-paired files (Chromium): each file + handle comes from
      // the same dropped item, so no filename matching is needed. Fall back to
      // the plain dropped files when no handles were captured (Firefox/Safari).
      const supportedOpened = (opened ?? []).filter((o) => isSupportedFile(o.file));
      const useHandles = supportedOpened.length > 0;
      const files = useHandles ? supportedOpened.map((o) => o.file) : supportedFiles;
      const handles = useHandles ? supportedOpened.map((o) => o.handle) : undefined;

      recordRecentFiles(files.map((file) => ({ name: file.name, size: file.size })));
      void cacheFileBlobs(files);
      setRecentFiles(getRecentFiles().slice(0, 3));

      routeLoad(files, handles);
    });
  }, [routeLoad, applyDragEvent, isSupportedFile, webgpu.supported]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Block file loading if WebGPU not supported
    if (!webgpu.supported) {
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter to supported files (IFC, IFCX, GLB). The <input> path yields no
    // live handle, so these models are not refreshable.
    const supportedFiles = Array.from(files).filter(isSupportedFile);

    if (supportedFiles.length === 0) return;

    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    setRecentFiles(getRecentFiles().slice(0, 3));

    routeLoad(supportedFiles);

    // Reset input so same file can be selected again
    e.target.value = '';
  }, [routeLoad, isSupportedFile, webgpu.supported]);

  // Preferred open path: the File System Access picker (Chromium) captures a
  // live handle per file so the model can be refreshed from disk. Falls back to
  // the hidden <input type="file"> on browsers without the API.
  const handleOpenClick = useCallback(async () => {
    if (!webgpu.supported) return;
    if (!supportsFileSystemAccess()) {
      fileInputRef.current?.click();
      return;
    }
    const opened = await openIfcFilesWithHandles();
    if (!opened) return;
    const supported = opened.filter((o) => isSupportedFile(o.file));
    if (supported.length === 0) return;

    const files = supported.map((o) => o.file);
    recordRecentFiles(files.map((f) => ({ name: f.name, size: f.size })));
    void cacheFileBlobs(files);
    setRecentFiles(getRecentFiles().slice(0, 3));

    routeLoad(files, supported.map((o) => o.handle));
  }, [routeLoad, isSupportedFile, webgpu.supported]);

  const handleStartBlank = useCallback(async () => {
    if (!webgpu.supported) return;
    const file = createBlankIfcFile();
    // Must await: loadFile() calls resetViewerState() internally which
    // resets activeTool back to 'select'. Setting addElement before that
    // races and leaves the user in select mode despite the click.
    await loadFile(file);
    setActiveTool('addElement');
  }, [webgpu.supported, loadFile, setActiveTool]);

  // Issue #540 "Merge Multilayer Walls" reload. The setting changes the produced
  // geometry, so it only takes on a re-load. Re-load the active model IN PLACE
  // from the File the store ALREADY retains on the model record
  // (`getActiveModel().sourceFile`, set by upsertModel at load time) — loadFile
  // re-snapshots `mergeLayers` from the store, so the toggle re-tessellates.
  // The earlier recent-files-blob-cache source was unreliable (its 150 MB cap
  // skips real models + a fire-and-forget write races the reload), so it fell to
  // window.location.reload() which DROPPED the model — the "nothing loads" blank.
  const handleMergeLayersReload = useCallback(async () => {
    const st = useViewerStore.getState();
    const file = st.getActiveModel()?.sourceFile;
    console.log(
      '[merge-reload] start: mergeLayers=',
      st.mergeLayers,
      'activeModel.sourceFile=',
      file ? `${file.name} (${file.size}B)` : 'NONE',
    );
    st.clearMergeLayersPendingReload();
    if (file) {
      try {
        console.log('[merge-reload] re-loading active model in place…');
        await loadFile(file);
        const after = useViewerStore.getState();
        console.log(
          '[merge-reload] loadFile resolved: meshes=',
          after.geometryResult?.meshes?.length ?? 0,
          'models=',
          after.models?.size ?? 0,
        );
      } catch (err) {
        console.error('[merge-reload] loadFile threw:', err);
      }
    } else if (typeof window !== 'undefined') {
      // No retained File (e.g. blank/new model) — fall back to a full reload
      // (the toggle is persisted, so the user re-opens the file).
      console.warn('[merge-reload] no active sourceFile — falling back to window.location.reload()');
      window.location.reload();
    }
  }, [loadFile]);

  // Reload-to-apply for the Fast/Exact geometry mode, mirroring the merge-layers
  // reload: re-load the active model in place so loadFile re-snapshots the mode
  // and re-tessellates. Clears BOTH pending flags since one reload applies every
  // load-time geometry setting.
  const handleGeometryModeReload = useCallback(async () => {
    const st = useViewerStore.getState();
    const file = st.getActiveModel()?.sourceFile;
    st.clearGeometryModePendingReload();
    st.clearMergeLayersPendingReload();
    if (file) {
      try {
        await loadFile(file);
      } catch (err) {
        console.error('[geom-mode-reload] loadFile threw:', err);
      }
    } else if (typeof window !== 'undefined') {
      // No retained File — fall back to a full reload (the mode is persisted).
      console.warn('[geom-mode-reload] no active sourceFile — falling back to window.location.reload()');
      window.location.reload();
    }
  }, [loadFile]);

  const hasGeometry = mergedGeometryResult?.meshes && mergedGeometryResult.meshes.length > 0;

  // Check if any models are loaded (even if hidden) - used to show empty 3D vs starting UI
  const hasLoadedModels = storeModels.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);

  // Does the rendered geometry carry any type-library geometry? geometryClass
  // 1 = orphan type, 2 = instanced type; class 0 = placed occurrence. The
  // Model/Types switch is only meaningful — and "Types" only renders anything —
  // when class 1/2 meshes exist, so we surface this to gate the toolbar control
  // (#957 follow-up). Scanned incrementally (O(batch)) and short-circuited once
  // any type mesh is seen, so the common occurrence-only model costs at most a
  // single linear pass that stops early.
  const typeGeoSourceRef = useRef<MeshData[] | null>(null);
  const typeGeoScanLenRef = useRef(0);
  const sawTypeGeometryRef = useRef(false);
  const hasTypeGeometry = useMemo(() => {
    const meshes = mergedGeometryResult?.meshes;
    if (!meshes || meshes.length === 0) {
      typeGeoSourceRef.current = meshes ?? null;
      typeGeoScanLenRef.current = meshes?.length ?? 0;
      sawTypeGeometryRef.current = false;
      return false;
    }
    // New source array, or it shrank (new file / replace) → rescan from scratch.
    if (typeGeoSourceRef.current !== meshes || meshes.length < typeGeoScanLenRef.current) {
      typeGeoSourceRef.current = meshes;
      typeGeoScanLenRef.current = 0;
      sawTypeGeometryRef.current = false;
    }
    if (!sawTypeGeometryRef.current) {
      for (let i = typeGeoScanLenRef.current; i < meshes.length; i++) {
        if ((meshes[i].geometryClass ?? 0) !== 0) { sawTypeGeometryRef.current = true; break; }
      }
    }
    typeGeoScanLenRef.current = meshes.length;
    return sawTypeGeometryRef.current;
    // geometryContentVersion bumps per streaming batch — picks up type geometry
    // that arrives in a later batch even when the meshes array is mutated in place.
  }, [mergedGeometryResult, geometryContentVersion]);

  // Does the model carry any PLACED occurrence (class 0)? Used to decide whether
  // orphan type-library geometry (class 1) is clutter to hide in Model view or
  // the only geometry that must stay visible (pure type-library files). Same
  // incremental-scan pattern as hasTypeGeometry. (#1353)
  const occGeoSourceRef = useRef<MeshData[] | null>(null);
  const occGeoScanLenRef = useRef(0);
  const sawOccurrenceRef = useRef(false);
  const hasOccurrenceGeometry = useMemo(() => {
    const meshes = mergedGeometryResult?.meshes;
    if (!meshes || meshes.length === 0) {
      occGeoSourceRef.current = meshes ?? null;
      occGeoScanLenRef.current = meshes?.length ?? 0;
      sawOccurrenceRef.current = false;
      return false;
    }
    if (occGeoSourceRef.current !== meshes || meshes.length < occGeoScanLenRef.current) {
      occGeoSourceRef.current = meshes;
      occGeoScanLenRef.current = 0;
      sawOccurrenceRef.current = false;
    }
    if (!sawOccurrenceRef.current) {
      for (let i = occGeoScanLenRef.current; i < meshes.length; i++) {
        if (meshClassIsPlaced(meshes[i].geometryClass ?? 0)) { sawOccurrenceRef.current = true; break; }
      }
    }
    occGeoScanLenRef.current = meshes.length;
    return sawOccurrenceRef.current;
  }, [mergedGeometryResult, geometryContentVersion]);

  // Persisted view mode may be 'types' from a prior model; fall back to 'model'
  // when the current geometry has no type library so "Types" never renders an
  // empty scene (and the now-hidden switch can't be used to recover).
  const effectiveViewMode = hasTypeGeometry ? typeViewMode : 'model';

  // Publish to the store so the toolbar can hide the Model/Types switch when
  // there is no type geometry to reveal.
  useEffect(() => {
    setHasTypeGeometry(hasTypeGeometry);
  }, [hasTypeGeometry, setHasTypeGeometry]);

  // PERF: Incremental geometry filtering using refs.
  // Instead of creating a new 200K+ element array every batch (~200ms),
  // we push ONLY new meshes into a cached array — O(batch_size) not O(total).
  // A version counter triggers downstream re-renders via the Viewport prop.
  const filteredCacheRef = useRef<MeshData[]>([]);
  const filteredSourceLenRef = useRef(0);
  const filteredSourceRef = useRef<MeshData[] | null>(null);
  const filteredTypeVisRef = useRef(typeVisibility);
  const filteredTypeModeRef = useRef(effectiveViewMode);
  const filteredHasOccRef = useRef(hasOccurrenceGeometry);
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

    // Full rebuild if: type visibility changed, view mode changed, source shrunk
    // (new file), or empty cache
    const prevVis = filteredTypeVisRef.current;
    const typeVisChanged =
      prevVis.spaces !== typeVisibility.spaces ||
      prevVis.spatialZones !== typeVisibility.spatialZones ||
      prevVis.openings !== typeVisibility.openings ||
      prevVis.virtualElements !== typeVisibility.virtualElements ||
      prevVis.site !== typeVisibility.site ||
      prevVis.ifcAnnotations !== typeVisibility.ifcAnnotations ||
      filteredTypeModeRef.current !== effectiveViewMode ||
      // Occurrence-presence flipping (e.g. occurrences stream in after orphan
      // types) changes whether class-1 orphans render in Model view (#1353).
      filteredHasOccRef.current !== hasOccurrenceGeometry;
    const sourceChanged = filteredSourceRef.current !== allMeshes;
    if (typeVisChanged || sourceChanged || allMeshes.length < filteredSourceLenRef.current) {
      cache.length = 0;
      filteredSourceLenRef.current = 0;
      filteredSourceRef.current = allMeshes;
      filteredTypeVisRef.current = typeVisibility;
      filteredTypeModeRef.current = effectiveViewMode;
      filteredHasOccRef.current = hasOccurrenceGeometry;
    }

    const needsFilter = !typeVisibility.spaces || !typeVisibility.spatialZones || !typeVisibility.openings || !typeVisibility.virtualElements || !typeVisibility.site || !typeVisibility.ifcAnnotations;
    const prevCacheLen = cache.length;

    // Only process NEW meshes since last run — O(batch_size) not O(total)
    for (let i = filteredSourceLenRef.current; i < allMeshes.length; i++) {
      const mesh = allMeshes[i];
      const ifcType = mesh.ifcType;

      // Model/Types view switch (#957, #1353). geometryClass: 0 = occurrence,
      // 1 = orphan type, 2 = instanced type-library shape, 3 = material-layer
      // slice (treated like an occurrence — it's part of the real build-up).
      // An orphan type (class 1) renders in Model view ONLY when the model has
      // no placed occurrences (pure type-library file); otherwise it's unplaced
      // library clutter and belongs in the Types view. See helper for the table.
      const geometryClass = mesh.geometryClass ?? 0;
      if (!isMeshVisibleInViewMode(geometryClass, effectiveViewMode, hasOccurrenceGeometry)) {
        continue;
      }

      // Type-visibility gate — shared mapping in `typeVisibilityFilter.ts`
      // keeps the viewport, Cesium, basket and GLB export in lockstep. The
      // `site` toggle also hides `IfcGeographicElement` terrain (issue #1480);
      // `ifcAnnotations` also hides annotation 3D solid geometry / "Model Text"
      // breps on top of the 2D curve overlay (issues #1354, #1480).
      if (needsFilter && !isTypeVisible(ifcType, typeVisibility)) continue;

      // Mesh alpha flows through unchanged. The previous code re-multiplied
      // IfcSpace / IfcOpeningElement alpha down to <= 0.3 here, which stomped
      // lens / Pset colour rules even when the user explicitly chose alpha 1.0.
      // Defaults still come from styling.rs / default-materials.ts; the
      // renderer promotes overridden entities to the opaque pipeline so the
      // overlay paint pass finds matching depth. See issue #677.
      cache.push(mesh);
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
  }, [mergedGeometryResult, typeVisibility, effectiveViewMode, hasOccurrenceGeometry]);

  // Version counter that changes every batch — triggers useGeometryStreaming
  // without requiring a new geometry array reference.
  const geometryVersion = filteredVersionRef.current;

  // 3D-context (Cesium) geometry must honour the SAME type-visibility filter as
  // the WebGPU viewport, or openings/spaces hidden in 2D/3D reappear in the
  // world view. The Cesium GLB builder reads `geometryResult.meshes`, so wrap the
  // result with the already-filtered mesh list (`filteredGeometry`) rather than
  // the raw `mergedGeometryResult` (issue #1337: a 900 m-tall IfcOpeningElement
  // roof-cutter rendered as a giant salmon column over the building because the
  // Cesium path skipped the opening filter that the viewport applies). Memoised
  // on geometryVersion so the GLB rebuilds when the visible set changes.
  const cesiumGeometryResult = useMemo(() => {
    if (!mergedGeometryResult || !filteredGeometry) return null;
    return { ...mergedGeometryResult, meshes: filteredGeometry };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedGeometryResult, filteredGeometry, geometryVersion]);

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
        // Pass the relationship graph so storey isolation pulls in the parts of
        // any decomposing assembly (stair flights, railings, …) — they live off
        // the spatial tree via IfcRelAggregates and would otherwise vanish (#1133).
        const relationships = model.ifcDataStore?.relationships as AggregationRelationships | undefined;

        for (const storeyId of selectedStoreys) {
          const localStoreyId = hierarchy.byStorey.has(storeyId)
            ? storeyId
            : storeyId - (model.idOffset ?? 0);
          const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, localStoreyId, relationships);
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
        const relationships = ifcDataStore.relationships as AggregationRelationships | undefined;
        for (const storeyId of selectedStoreys) {
          const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, storeyId, relationships);
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
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <GridPattern />

        <input
          ref={fileInputRef}
          type="file"
          accept=".ifc,.ifcx,.ifczip,.glb,.las,.laz,.ply,.pcd,.e57,.pts,.xyz"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Drop overlay */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-50 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center p-8">
            <div className="border-4 border-dashed border-primary bg-white/90 dark:bg-black/90 p-12 max-w-2xl w-full text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] transition-all">
              <Upload className="h-20 w-20 mx-auto text-primary mb-6" />
              <p className="text-3xl font-black uppercase tracking-tight text-primary">Drop File to Load</p>
            </div>
          </div>
        )}

        {/* WebGPU Not Supported Banner — compact on mobile */}
        {!webgpu.checking && !webgpu.supported && (
          <div className="absolute top-0 left-0 right-0 z-40 max-h-[40vh] overflow-auto">
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

        {/* Empty state content — mobile-optimized padding and scrollable */}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 md:p-8 z-10 overflow-auto">

          {/* Main Card */}
          <div {...tourAnchor(TOUR_ANCHORS.emptyStateCard)} className="max-w-md w-full bg-white dark:bg-[#16161e] border border-zinc-300 dark:border-[#3b4261] p-8 flex flex-col items-center transition-transform hover:-translate-y-1 duration-200 shadow-lg">
            
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
              IFC toolkit for the open web
            </p>

            {/*
              Two-track action area: a primary "open file" track and a
              secondary "drive with LLM" track sit in mirrored slots — same
              width, same vertical rhythm, each followed by its own caption
              line. Reads as one balanced composition instead of a primary
              CTA + a tacked-on link, while keeping the file-open path
              visually dominant via the filled-on-hover treatment.
            */}
            {/* Track 1 — open / drag */}
            <button
              onClick={() => { void handleOpenClick(); }}
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

            <p className="mt-2.5 text-[11px] font-mono text-center text-zinc-400 dark:text-[#565f89]">
              {webgpu.supported ? 'or drag & drop anywhere' : 'file upload disabled'}
            </p>

            {/* Subtle "or" rule — anchors the symmetry between the two tracks */}
            <div className="mt-5 mb-5 w-full flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-400 dark:text-[#565f89]">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
              <span>or</span>
              <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
            </div>

            {/* Track 2 — two peer pills that both answer "I don't have a
                file to open": start a fresh project, or hand the wheel to
                an LLM via MCP. Both share the same dashed-pill silhouette
                so they read as siblings, with the file-open CTA above
                staying visually dominant. */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => { void handleStartBlank(); }}
                disabled={!webgpu.supported || webgpu.checking}
                className={`group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] border border-dashed transition-all ${
                  !webgpu.supported || webgpu.checking
                    ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
                    : 'border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary cursor-pointer'
                }`}
              >
                <PackagePlus className="h-3 w-3 transition-transform group-enabled:group-hover:-translate-y-0.5" />
                <span>Start blank</span>
              </button>
              <a
                href="/mcp"
                className="group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] border border-dashed border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary transition-all cursor-pointer"
              >
                <Sparkles className="h-3 w-3 transition-transform group-hover:-translate-y-0.5" />
                <span>Drive with any LLM</span>
                <ArrowUpRight className="h-2.5 w-2.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </a>
            </div>

            <p className="mt-1.5 text-[10px] font-mono text-center text-zinc-400 dark:text-[#565f89]">
              new untitled project · or LLM via MCP
            </p>

            {/* First-run tour invite — needs loadFile, so it shares the
                WebGPU gate of every other action on this card. */}
            {webgpu.supported && !webgpu.checking && <TourInvite />}

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
                        void handleOpenClick();
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

          {/* Feature Grid — hidden on mobile to save viewport space */}
          <div className="mt-16 hidden md:grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl w-full">
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

          {/* Footer chips — left: discovery link to the marketing site for first-time
              visitors, right: shortcuts cue for power users. Both desktop-only. */}
          <div className="absolute bottom-8 left-8 hidden md:block">
            <a
              href="https://ifclite.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 text-xs font-mono px-3 py-1.5 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#565f89] hover:border-primary hover:text-primary transition-colors"
            >
              <span>New here?</span>
              <span className="font-bold text-primary group-hover:translate-x-0.5 transition-transform">ifclite.dev →</span>
            </a>
          </div>
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
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay for when a file is already loaded - shows "Add Model" */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 bg-[#9ece6a]/10 backdrop-blur-[2px] flex items-center justify-center">
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
      {cesiumEnabled && georef && (
        <CesiumOverlay
          mapConversion={georef.mapConversion}
          cameraMapConversion={georef.baseMapConversion}
          projectedCRS={georef.projectedCRS}
          coordinateInfo={georef.coordinateInfo}
          geometryResult={cesiumGeometryResult}
          lengthUnitScale={georef.lengthUnitScale}
          storeyElevations={georef.storeyElevations}
        />
      )}
      {/* Sun & Sky panel — sky, lighting presets and the sun-path study.
          Self-anchored below the ViewCube (top-6 right-6 cube) at top-32 right-4
          so it never covers navigation; draggable from its header (#1107). */}
      <SunSkyPanel />
      {/* SpaceMouse panel — WebHID 3D mouse connection + sensitivity (#1677).
          Anchored below the Sun & Sky spot so both can be open; draggable. */}
      <SpaceMousePanel />
      {cesiumEnabled && georef?.mapConversion && georef.baseMapConversion && (
        <CesiumPlacementEditor
          modelId={georef.sourceModelId}
          mapConversion={georef.mapConversion}
          baseMapConversion={georef.baseMapConversion}
          projectedCRS={georef.projectedCRS}
          coordinateInfo={georef.coordinateInfo}
          lengthUnitScale={georef.lengthUnitScale}
          storeyElevations={georef.storeyElevations}
        />
      )}
      <Viewport
        geometry={filteredGeometry}
        geometryVersion={geometryVersion}
        geometryContentVersion={geometryContentVersion}
        pointClouds={mergedPointClouds}
        coordinateInfo={mergedGeometryResult?.coordinateInfo}
        computedIsolatedIds={computedIsolatedIds}
        modelIdToIndex={modelIdToIndex}
        cesiumActive={cesiumEnabled && georef !== null}
        releaseGeometryAfterStream={false}
        onGeometryReleased={releaseGeometryMemory}
      />
      <AnnotationLayer />
      <CollabPresenceLayer />
      {bcfOverlayVisible && <BCFOverlay />}
      <ViewportOverlays />
      {/* Issue #540: non-modal "reload to apply" banner anchored to the
          top of the canvas. Only renders when the user has flipped the
          merge-layers toggle while a model is in scope. `onReload` re-loads the
          model in place (full page reload would drop it — no boot auto-restore). */}
      <MergeLayersBanner onReload={handleMergeLayersReload} />
      <GeometryModeBanner onReload={handleGeometryModeReload} />
      <LevelDisplayIndicator />
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
