/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { usePlacementCoordinateInfo } from '@/hooks/usePlacementCoordinateInfo';
import { useFederatedGeometry } from './useFederatedGeometry';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { useMemo, useRef, useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLevelDisplayEffect } from '@/hooks/useLevelDisplayEffect';
import { ingestDxfFiles, splitDxfFiles } from '@/hooks/ingest/dxfIngest';
import { Viewport } from './Viewport';
import { useWindowFileDrop } from './useWindowFileDrop';
import { ViewportOverlays } from './ViewportOverlays';
import { WebGpuTroubleshootingDetails, webGpuBannerBlurb } from './WebGpuTroubleshooting';
import { ViewportWelcomeCard } from './ViewportWelcomeCard';
import { WelcomeFooterChips } from './WelcomeFooterChips';
import { useTranslation } from '@/i18n';
import { MergeLayersBanner } from './MergeLayersBanner';
import { GeometryModeBanner } from './GeometryModeBanner';
import { LandXmlUnitsRefusalPrompt } from './LandXmlUnitsRefusalPrompt';
import { VisibilityChips } from '@/components/viewport-ui/hud/VisibilityChips';
import { ToolOverlays } from './ToolOverlays';
import { ZoneOverlay, ZoneAssignmentSyncMount } from './tools/ZoneOverlay';
import { AnnotationLayer } from './annotations/AnnotationLayer';
import { CollabPresenceLayer } from './CollabPresenceLayer';
import { BasepointOverlay } from './BasepointOverlay';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { DrawingRuntimeHost } from './drawing/DrawingRuntimeHost';
import { BCFOverlay } from './bcf/BCFOverlay';
import { CesiumOverlay } from './CesiumOverlay';
import { CesiumPlacementGizmo } from './placement/CesiumPlacementGizmo';
import { useSolarEnvironment } from '@/hooks/useSolarEnvironment';
import { useSolarSweep } from '@/hooks/useSolarSweep';
import { getViewerStoreApi, useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { collectIfcBuildingStoreyElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import type { AggregationRelationships } from '@/utils/aggregation';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import type { RecentFileEntry } from '@/lib/recent-files';
import {
  supportsFileSystemAccess,
  openIfcFilesWithHandles,
  handlesFromDataTransfer,
} from '@/services/file-system-access';
import { FILE_ACCEPT, isGltfBundleFile, isSupportedModelFile } from '@/services/supported-model-files';
import { usePreparedModelFileRoute } from '@/hooks/ingest/usePreparedModelFileRoute';
import {
  SOURCE_DOWNLOAD_EVENT,
  type SourceDownloadEvent,
  type SourceDownloadItem,
} from '@/services/sources/source-host';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { recordDownloadedSourceFile } from '@/lib/sources/persistence';
import { sanitizeFilename } from '@/lib/export/download';
import { enqueueSourceLoad } from '@/lib/sources/loadQueue';
import { toast, Toaster } from '@/components/ui/toast';
import { reportFileOpenRejected } from '@/hooks/ingest/fileOpenRejected';
import { Upload, AlertTriangle, ChevronDown, ExternalLink, Plus } from 'lucide-react';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import type { MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import { type IfcDataStore, type MapConversion } from '@ifc-lite/parser';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef';
import { isMeshVisibleInViewMode, meshClassIsPlaced, meshIsNonOccurrence } from '@/lib/type-view-visibility';

export function ViewportContainer() {
  // Drive Stacked / Solo / Exploded level display from the slice.
  // Mount-once hook — it self-gates on mode + gap + model changes.
  useLevelDisplayEffect();

  const { loadFile, loading, clearAllModels, loadFilesSequentially, addModel } = useIfc();
  // Resolves a source provider's display title for toasts; null outside the
  // SourceHostProvider tree (tests), in which case the machine name is shown.
  const sourceHost = useOptionalSourceHost();
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
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const webgpu = useWebGPU();
  // `webGpuBannerBlurb` is a plain function, not a component — pass this
  // component's own `t` so the banner headline re-renders on a live locale
  // switch instead of reading the registry's non-reactive `resolve` default
  // (review on #5086).
  const { t } = useTranslation();

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
    geometryContentVersion,
  } = viewportStoreState;
  const storeModels = models;

  // Multi-model: create mapping from modelId to modelIndex (stable order)
  const modelIdToIndex = useMemo(() => modelIndices(storeModels), [storeModels]);

  const mergedGeometryResult = useFederatedGeometry(storeModels, geometryResult, modelIdToIndex, geometryContentVersion);

  const placedCoordinateInfo = usePlacementCoordinateInfo(mergedGeometryResult?.coordinateInfo);

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

  const isSupportedFile = isSupportedModelFile;

  // Single routing point for every ingestion path (picker / drop / input). The
  // optional `handles` array is positionally aligned with `files` and carries a
  // live FS Access handle per file when one was captured (Chromium) so the model
  // stays refreshable; entries are `undefined` otherwise.
  const routeLoad = useCallback((
    files: File[],
    handles?: (FileSystemFileHandle | undefined)[],
  ) => {
    // Read the loaded state now, not at render: bundle preparation awaits
    // before routing, and a model that arrived meanwhile must be added to,
    // not replaced (#4476 review).
    const current = viewerStoreApi.getState();
    const hasModelsLoaded = current.models.size > 0 || (current.geometryResult?.meshes?.length ?? 0) > 0;
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
  }, [loadFile, loadFilesSequentially, resetViewerState, clearAllModels, viewerStoreApi]);

  const prepareAndRoute = usePreparedModelFileRoute(routeLoad, setRecentFiles);

  // Cloud source providers (Dalux Build, etc.) download bytes outside the
  // viewer and hand them off via this event rather than calling addModel()
  // directly — keeps the sources UI decoupled from viewer internals.
  //
  // Batches are SERIALIZED through the shared source-load queue: a second
  // batch arriving while the first is still loading must not run
  // `resetViewerState()` / `clearAllModels()` mid-finalize, and two
  // `addModel` loops must never interleave (the WASM parser is not
  // thread-safe). Per-model syncs (syncSourceModel) route through the same
  // queue, so a Sync clicked mid-batch waits its turn too. "Are models
  // loaded?" is read from the store at run time, not from a closure captured
  // at dispatch time. Each item's buffer reference is dropped as soon as its
  // model has loaded so a large batch is not held in memory wholesale.
  useEffect(() => {
    const handleSourceDownload = (event: Event) => {
      const detail = (event as SourceDownloadEvent).detail;
      if (detail.items.length === 0) return;
      // Take ownership of the items and drop the event's own reference so
      // consumed buffers become collectable as the queue works through them.
      const batch: Array<SourceDownloadItem | null> = [...detail.items];
      detail.items.length = 0;

      void enqueueSourceLoad(async () => {
        // An unexpected throw must never escape this task unreported: the
        // queue itself survives rejections, but the user still needs to hear
        // that their batch died rather than watching nothing happen.
        try {
          const store = useViewerStore.getState();
          const anyLoaded =
            store.models.size > 0 || (store.geometryResult?.meshes?.length ?? 0) > 0;
          if (!anyLoaded) {
            resetViewerState();
            clearAllModels();
          }

          for (let i = 0; i < batch.length; i++) {
            const item = batch[i];
            if (!item) continue;
            batch[i] = null; // release the buffer once this iteration owns it
            // `item.name` comes from a remote provider's file listing — it is
            // untrusted input reaching a filename position (the File
            // constructor, the model name, and every toast below). Sanitize
            // once and use the sanitized value everywhere downstream.
            const safeName = sanitizeFilename(item.name, { fallback: 'model.ifc' });
            const file = new File([item.buffer], safeName);
            // Pass an explicit id and treat "registered in the store" as
            // success: addModel returns null when a concurrent load
            // (drag-drop, viewport picker) bumps the shared load session,
            // even though this model finished registering — same recovery
            // syncSourceModel uses. Without it the toast would falsely report
            // a failure and the model would get no source tag (no sync
            // button, no badge, no downloaded-file record).
            const providerTitle =
              sourceHost?.get(item.tag.provider)?.manifest.title ?? item.tag.provider;
            // Isolate each item: a single corrupt or unparseable file must not
            // abandon the rest of the batch. Without this, one bad IFC out of
            // ten throws to the outer catch and the other nine silently never
            // load — with one generic toast for the whole batch.
            try {
              const modelId = crypto.randomUUID();
              const added = await addModel(file, { name: safeName, modelId });
              const registered = added !== null || useViewerStore.getState().models.has(modelId);
              if (registered) {
                useViewerStore.getState().setSourceTag(modelId, item.tag);
                recordDownloadedSourceFile(item.tag, item.sourceFile);
                toast.success(`Loaded ${safeName} from ${providerTitle}`);
              } else {
                toast.error(`Failed to load ${safeName} from ${providerTitle}`);
              }
            } catch (itemError) {
              console.error(`[sources] Failed to load ${safeName}:`, itemError);
              toast.error(`Failed to load ${safeName} from ${providerTitle}`);
            }
          }
        } catch (error) {
          console.error('[sources] Failed to load a source download batch:', error);
          toast.error(
            error instanceof Error
              ? `Failed to load models from cloud source: ${error.message}`
              : 'Failed to load models from cloud source',
          );
        }
      });
    };

    window.addEventListener(SOURCE_DOWNLOAD_EVENT, handleSourceDownload);
    return () =>
      window.removeEventListener(SOURCE_DOWNLOAD_EVENT, handleSourceDownload);
  }, [addModel, resetViewerState, clearAllModels, sourceHost]);

  // The whole window is the drop target (#5845): a file dropped on the
  // toolbar, sidebar or a panel loads too, and the browser never navigates to
  // it. Drops are refused (not loaded) while WebGPU is unsupported.
  const handleDrop = useCallback((dataTransfer: DataTransfer) => {
    // Capture live handles synchronously — the DataTransferItemList is neutered
    // once the drop event returns, so this must run before any await.
    const handlesPromise = handlesFromDataTransfer(dataTransfer);

    // DXF reference underlays split off before model routing (issue #1782):
    // a dropped site plan must never replace or federate with the model.
    const allDropped0 = Array.from(dataTransfer.files);
    const { dxfFiles, modelFiles: allDropped } = splitDxfFiles(allDropped0);
    if (dxfFiles.length > 0) void ingestDxfFiles(dxfFiles);
    if (allDropped.length === 0) return;

    // Keep glTF sidecars beside the document until they are packed into GLB.
    const supportedFiles = allDropped.filter(file => isSupportedFile(file) || isGltfBundleFile(file));

    if (supportedFiles.length === 0) {
      reportFileOpenRejected(allDropped);
      return;
    }

    void handlesPromise.then((opened) => {
      // Prefer the handle-paired files (Chromium): each file + handle comes from
      // the same dropped item, so no filename matching is needed. Fall back to
      // the plain dropped files when no handles were captured (Firefox/Safari).
      const supportedOpened = (opened ?? []).filter((o) => isSupportedFile(o.file) || isGltfBundleFile(o.file));
      const useHandles = supportedOpened.length > 0;
      const files = useHandles ? supportedOpened.map((o) => o.file) : supportedFiles;
      const handles = useHandles ? supportedOpened.map((o) => o.handle) : undefined;

      void prepareAndRoute(files, handles);
    });
  }, [prepareAndRoute, isSupportedFile]);
  const isDragging = useWindowFileDrop(handleDrop, webgpu.supported);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Block file loading if WebGPU not supported
    if (!webgpu.supported) {
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;

    // DXF reference underlays split off before model routing (issue #1782).
    const { dxfFiles, modelFiles } = splitDxfFiles(Array.from(files));
    if (dxfFiles.length > 0) void ingestDxfFiles(dxfFiles);

    // Filter to supported files (IFC, IFCX, GLB). The <input> path yields no
    // live handle, so these models are not refreshable.
    const supportedFiles = modelFiles.filter(file => isSupportedFile(file) || isGltfBundleFile(file));

    if (supportedFiles.length > 0) void prepareAndRoute(supportedFiles);
    else reportFileOpenRejected(modelFiles);
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [prepareAndRoute, isSupportedFile, webgpu.supported]);

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
    // DXF reference underlays split off before model routing (issue #1782).
    const dxfPicked = opened.filter((o) => o.file.name.toLowerCase().endsWith('.dxf'));
    if (dxfPicked.length > 0) void ingestDxfFiles(dxfPicked.map((o) => o.file));
    const supported = opened.filter((o) => isSupportedFile(o.file) || isGltfBundleFile(o.file));
    if (supported.length === 0) {
      reportFileOpenRejected(opened.map((o) => o.file));
      return;
    }

    const files = supported.map((o) => o.file);
    prepareAndRoute(files, supported.map((o) => o.handle));
  }, [prepareAndRoute, isSupportedFile, webgpu.supported]);

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
        if (meshIsNonOccurrence(meshes[i])) { sawTypeGeometryRef.current = true; break; }
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
      >
        <GridPattern />

        <input
          ref={fileInputRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Drop overlay — full window, since the whole window is the drop target (#5845) */}
        {isDragging && createPortal(
          <div className="pointer-events-none fixed inset-0 z-50 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center p-8">
            <div className="border-4 border-dashed border-primary bg-white/90 dark:bg-black/90 p-12 max-w-2xl w-full text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] transition-all">
              <Upload className="h-20 w-20 mx-auto text-primary mb-6" />
              <p className="text-3xl font-black uppercase tracking-tight text-primary">{t('viewportLighting.container.emptyState.dropOverlay.title')}</p>
            </div>
          </div>,
          document.body,
        )}

        {/* WebGPU Not Supported Banner — compact on mobile; tokens, not the hard-coded Tokyo Night hex (#5504). */}
        {!webgpu.checking && !webgpu.supported && (
          <div className="absolute top-0 left-0 right-0 z-40 max-h-[40vh] overflow-auto">
            {/* Hazard stripes background */}
            <div
              className="absolute inset-0 opacity-10"
              style={{ backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 10px, var(--color-destructive) 10px, var(--color-destructive) 20px)' }}
            />
            <div className="relative border-b-4 border-destructive bg-background px-4 py-5">
              <div className="max-w-3xl mx-auto flex items-start gap-4">
                {/* Icon container with brutalist frame */}
                <div className="flex-shrink-0 border-2 border-destructive p-2 bg-destructive/10">
                  <AlertTriangle className="h-6 w-6 text-destructive" />
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-black text-lg uppercase tracking-wider text-destructive mb-1">
                    {t('viewportLighting.container.emptyState.webgpuBanner.heading')}
                  </h3>
                  <p className="font-mono text-sm text-foreground/80 leading-relaxed">
                    {webGpuBannerBlurb(webgpu.category, t)}
                    {webgpu.reason && (
                      <span className="block mt-1 text-muted-foreground">
                        {webgpu.reason}
                      </span>
                    )}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      href="https://caniuse.com/webgpu"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono uppercase tracking-wide border border-border text-primary hover:border-primary hover:bg-primary/10 transition-colors"
                    >
                      {t('viewportLighting.container.emptyState.webgpuBanner.checkBrowserSupport')}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="inline-flex items-center px-3 py-1 text-xs font-mono text-muted-foreground border border-border">
                      {t('viewportLighting.container.emptyState.webgpuBanner.supportedBrowsers')}
                    </span>
                  </div>

                  {/* Troubleshooting Section */}
                  <button
                    onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                    className="mt-4 flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-amber-600 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showTroubleshooting ? 'rotate-180' : ''}`} />
                    {showTroubleshooting
                      ? t('viewportLighting.container.emptyState.webgpuBanner.hideTroubleshooting')
                      : t('viewportLighting.container.emptyState.webgpuBanner.showTroubleshooting')}
                  </button>

                  {showTroubleshooting && (
                    <WebGpuTroubleshootingDetails category={webgpu.category} />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state content — mobile-optimized padding and scrollable.
            The scroll container must NOT center via justify-center: a flex
            child taller than an overflow-auto parent gets its top clipped
            beyond scroll reach (the logo used to vanish under the toolbar
            on short viewports). Instead an inner min-h-full column centers
            when there is room and grows scrollably from the top when not. */}
        <div className="absolute inset-0 z-10 overflow-auto p-4 md:p-8">
          <div className="min-h-full w-full flex flex-col items-center justify-center">

          {/* Main Card — extracted to its own module (#5119) so the privacy
              footnote had somewhere to land without growing this file. */}
          <ViewportWelcomeCard
            webgpu={webgpu}
            onOpenClick={() => { void handleOpenClick(); }}
            onStartBlank={() => { void handleStartBlank(); }}
            recentFiles={recentFiles}
            loadFile={loadFile}
          />

          {/* The old Select / Filter / Analyze feature-card grid was
              dropped: it repeated toolbar affordances without offering an
              action, and its height pushed the welcome card off-screen. */}

          <WelcomeFooterChips />

          </div>
        </div>
        <Toaster variant="absolute" />
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full bg-zinc-50 dark:bg-black overflow-hidden"
      data-viewport
    >
      {/* Drop overlay for a loaded file - "Add Model"; `status-ok` (tokens, #5504) sets it apart from the plain overlay above. */}
      {isDragging && createPortal(
        <div className="pointer-events-none fixed inset-0 z-50 bg-status-ok/10 backdrop-blur-[2px] flex items-center justify-center">
          <div className="bg-background border-4 border-dashed border-status-ok p-8 shadow-2xl">
            <div className="text-center">
              <Plus className="h-12 w-12 mx-auto text-status-ok mb-4" />
              <p className="text-xl font-black uppercase text-status-ok">{t('viewportLighting.container.dropOverlay.addModelTitle')}</p>
              <p className="text-sm font-mono text-muted-foreground mt-2">
                {t('viewportLighting.container.dropOverlay.addModelSubtitle', { count: models.size })}
              </p>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Cesium 3D world context overlay — rendered behind the WebGPU canvas (web only) */}
      {cesiumEnabled && georef && (
        <CesiumOverlay
          mapConversion={georef.mapConversion}
          cameraMapConversion={georef.baseMapConversion}
          projectedCRS={georef.projectedCRS}
          coordinateInfo={georef.coordinateInfo}
          geometryResult={cesiumGeometryResult}
          computedIsolatedIds={computedIsolatedIds}
          lengthUnitScale={georef.lengthUnitScale}
          storeyElevations={georef.storeyElevations}
        />
      )}
      {cesiumEnabled && georef?.mapConversion && georef.baseMapConversion && (
        <CesiumPlacementGizmo
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
        sectionCoordinateInfo={placedCoordinateInfo}
        computedIsolatedIds={computedIsolatedIds}
        modelIdToIndex={modelIdToIndex}
        cesiumActive={cesiumEnabled && georef !== null}
        releaseGeometryAfterStream={false}
        onGeometryReleased={releaseGeometryMemory}
      />
      {/* ONE scene-overlay kernel per viewport (#5486, #5511, #5512, was
          two roots until `ToolOverlays` (#5502) consolidated here). */}
      <SceneOverlayRoot>
        <AnnotationLayer />
        <CollabPresenceLayer />
        {bcfOverlayVisible && <BCFOverlay />}
        <BasepointOverlay />
        <ZoneOverlay />
        <ToolOverlays />
      </SceneOverlayRoot>
      <ViewportOverlays />
      {/* Issue #540: non-modal "reload to apply" banner anchored to the
          top of the canvas. Only renders when the user has flipped the
          merge-layers toggle while a model is in scope. `onReload` re-loads the
          model in place (full page reload would drop it — no boot auto-restore). */}
      <MergeLayersBanner onReload={handleMergeLayersReload} />
      <GeometryModeBanner onReload={handleGeometryModeReload} />
      {/* #5175: offers a retry with a user-chosen linear unit when a LandXML
          load refuses because the source declares no <Units>. */}
      <LandXmlUnitsRefusalPrompt />
      <VisibilityChips />
      <ZoneAssignmentSyncMount />
      <DrawingRuntimeHost mergedGeometry={mergedGeometryResult} computedIsolatedIds={computedIsolatedIds} />
      <Toaster variant="absolute" />
    </div>
  );
}
