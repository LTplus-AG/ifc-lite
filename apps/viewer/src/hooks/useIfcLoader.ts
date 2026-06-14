/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for loading and processing IFC files (single-model path)
 * Handles format detection, WASM geometry streaming, IFC parsing,
 * cache management, and server-side parsing delegation
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { getViewerStoreApi, useViewerStore, type FederatedModel } from '@/store';
import { IfcParser, detectFormat, type IfcDataStore } from '@ifc-lite/parser';
import { WorkerParser } from '@ifc-lite/parser/browser';
import { memoryAccounting } from '../lib/perf/memoryAccounting.js';
import {
  GeometryProcessor,
  GeometryQuality,
  getGeometryStreamWatchdogMs as getGeometryStreamWatchdogMsImpl,
  type MeshData,
  type CoordinateInfo,
  type GeometryResult,
} from '@ifc-lite/geometry';
import { acquireFileBuffer, type AcquiredBuffer } from '../utils/acquireFileBuffer.js';
import { buildSpatialIndexGuarded, buildSpatialIndexForModel } from '../utils/loadingUtils.js';
import { type GeometryData, FORMAT_VERSION } from '@ifc-lite/cache';

import { SERVER_URL, USE_SERVER, CACHE_SIZE_THRESHOLD, CACHE_MAX_SOURCE_SIZE, getDynamicBatchConfig } from '../utils/ifcConfig.js';
import {
  calculateMeshBounds,
  createCoordinateInfo,
  getRenderIntervalMs,
  calculateStoreyHeights,
} from '../utils/localParsingUtils.js';
import { applyColorUpdatesToMeshes } from './meshColorUpdates.js';

// Cache hook
import { useIfcCache, getCached } from './useIfcCache.js';

// Server hook
import { useIfcServer } from './useIfcServer.js';

import { getMaxExpressId, parseGlbViewerModel, parseIfcxViewerModel } from './ingest/viewerModelIngest.js';
import { boundedIteratorReturn } from './ingest/streamCleanup.js';
import { detectPointCloudFormat, ingestPointCloud } from './ingest/pointCloudIngest.js';
import { getGlobalRenderer } from './useBCF.js';
import { extractModelGeoref, alignGeometryToReference, findReferenceGeorefModel } from './ingest/federationAlign.js';
import { toast } from '../components/ui/toast.js';

/**
 * Where a {@link useIfcLoader.loadFile} call should land the model.
 *
 * `primary` is the historical single-model load: it resets all viewer state,
 * clears the model map, and streams progressively into the active slot.
 * `federated` is an additional model joining an existing federation — it does
 * NOT reset state, carries the pre-allocated `modelId`, and the shared RTC
 * origin picked by the federation gate. Both flow through the SAME geometry
 * pipeline + the SAME `finalizeModel`, so load-time behaviour can never again
 * diverge between the two (the cause of the model-diff "all geometry changed"
 * bug). The georef anchor + the user's saved georef edits are resolved inside
 * `finalizeModel` from the live store, exactly as the old federated path did.
 * Default is `primary`.
 */
export type LoadTarget =
  | { kind: 'primary' }
  | {
      kind: 'federated';
      modelId: string;
      name?: string;
      visible?: boolean;
      collapsed?: boolean;
      loadedAt?: number;
      /** Shared RTC offset from the earliest existing model (IFC Z-up). */
      sharedRtcOffset?: { x: number; y: number; z: number };
    };

/**
 * Compute a fast content fingerprint from the first and last 4KB of a buffer.
 * Uses FNV-1a hash for speed — no crypto overhead, sufficient to distinguish
 * files with identical name and byte length.
 */
function computeFastFingerprint(buffer: ArrayBuffer): string {
  const CHUNK_SIZE = 4096;
  const view = new Uint8Array(buffer);
  const len = view.length;

  // FNV-1a hash
  let hash = 2166136261; // FNV offset basis (32-bit)
  const firstEnd = Math.min(CHUNK_SIZE, len);
  for (let i = 0; i < firstEnd; i++) {
    hash ^= view[i];
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  if (len > CHUNK_SIZE) {
    const lastStart = Math.max(CHUNK_SIZE, len - CHUNK_SIZE);
    for (let i = lastStart; i < len; i++) {
      hash ^= view[i];
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16);
}

/**
 * Geometry stream watchdog. Delegates to the package-level helper so the
 * formula stays unit-tested in `@ifc-lite/geometry`. The first-batch deadline
 * grows with file size to give the single-threaded WASM pre-pass time to finish
 * on multi-GB files (issue #600). The subsequent-batch deadline is a FIXED
 * grace, deliberately NOT scaled by size: the mid-stream silent window is one
 * bounded `processGeometryBatch` call's wall-time (CSG density), which is
 * uncorrelated with megabytes — the old per-MB ramp killed healthy CSG-dense
 * loads (issue #1097).
 */
function getGeometryStreamWatchdogMs(
  desktopStableWasm: boolean,
  batchCount: number,
  fileSizeMB: number = 0,
): number {
  return getGeometryStreamWatchdogMsImpl({
    desktopStableWasm,
    batchCount,
    fileSizeMB,
  });
}


/**
 * Hook providing file loading operations for single-model path
 * Includes binary cache support for fast subsequent loads
 */
export function useIfcLoader() {
  // Guard against stale async writes when user loads a new file before previous completes.
  // Incremented on each loadFile call; deferred callbacks check their captured session.
  const loadSessionRef = useRef(0);

  const {
    setLoading,
    setGeometryStreamingActive,
    setError,
    setProgress,
    setGeometryProgress,
    setMetadataProgress,
    setIfcDataStore,
    setGeometryResult,
    setBoundedGeometryMode,
    appendGeometryBatch,
    updateMeshColors,
    updateCoordinateInfo,
    upsertModel,
    updateModel,
    registerModelOffset,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setGeometryStreamingActive: s.setGeometryStreamingActive,
    setError: s.setError,
    setProgress: s.setProgress,
    setGeometryProgress: s.setGeometryProgress,
    setMetadataProgress: s.setMetadataProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    setBoundedGeometryMode: s.setBoundedGeometryMode,
    appendGeometryBatch: s.appendGeometryBatch,
    updateMeshColors: s.updateMeshColors,
    updateCoordinateInfo: s.updateCoordinateInfo,
    upsertModel: s.upsertModel,
    updateModel: s.updateModel,
    registerModelOffset: s.registerModelOffset,
  })));

  // Cache operations from extracted hook
  const { loadFromCache, saveToCache } = useIfcCache();

  // Server operations from extracted hook
  const { loadFromServer } = useIfcServer();

  const loadFile = useCallback(async (
    file: File,
    target: LoadTarget = { kind: 'primary' },
  ) => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();
    // Only a primary (destructive, replace-everything) load bumps the session.
    // Federated adds are independent and run concurrently — they capture the
    // current session without invalidating each other; a subsequent primary
    // load still bumps it and aborts any in-flight federated adds.
    const currentSession = target.kind === 'primary'
      ? ++loadSessionRef.current
      : loadSessionRef.current;
    // Federated adds carry a pre-allocated id; primary loads mint a fresh one.
    const modelId = target.kind === 'federated' ? target.modelId : crypto.randomUUID();

    // Track total elapsed time for complete user experience
    const totalStartTime = performance.now();

    try {
      // Reset all viewer state before loading new file — PRIMARY ONLY. A
      // federated add must never wipe model #1; it joins the existing map.
      if (target.kind === 'primary') {
        resetViewerState();
        clearAllModels();
      }

      // Reset memory accounting so per-load summaries don't accumulate across files.
      memoryAccounting.reset();
      memoryAccounting.recordPhase({ phase: 'load-start' });

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      const fileName = file.name;
      const fileSize = file.size;
      const fileSizeMB = fileSize / (1024 * 1024);

      // PRIMARY owns the active-model slots + top-level UI/memory flags and
      // creates the model record. A federated add leaves all of that untouched
      // (model #1 must not be disturbed) and registers atomically at finalize
      // via addModel — so it creates NO placeholder entry here (which also
      // keeps the `collapsed` default counting only the other models).
      if (target.kind === 'primary') {
        setGeometryStreamingActive(false);
        setBoundedGeometryMode(false);
        setGeometryProgress(null);
        setMetadataProgress(null);

        upsertModel({
          id: modelId,
          name: fileName,
          ifcDataStore: null,
          geometryResult: null,
          visible: true,
          collapsed: false,
          schemaVersion: 'IFC4',
          loadedAt: Date.now(),
          fileSize,
          sourceFile: file,
          idOffset: 0,
          maxExpressId: 0,
          loadState: 'pending',
          geometryLoadState: 'pending',
          metadataLoadState: 'idle',
          interactiveReady: false,
          cacheState: 'none',
          loadError: null,
        });
        updateModel(modelId, {
          loadState: 'streaming-geometry',
          geometryLoadState: 'opening',
          metadataLoadState: 'idle',
          interactiveReady: false,
        });
      }

      // The ONE finalizer for every format/platform/role. Primary keeps the
      // historical updateModel-only behaviour; federated runs the georef-align
      // → id-offset → relabel → spatial-index → addModel sequence lifted
      // verbatim from the old useIfcFederation.addModel block (same order).
      const finalizeModel = async (
        dataStore: IfcDataStore | null,
        geometryResult: GeometryResult | null,
        schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5',
        patch?: { loadState?: 'pending' | 'streaming-geometry' | 'hydrating-metadata' | 'complete' | 'error'; cacheState?: 'none' | 'hit' | 'miss' | 'writing'; loadError?: string | null; pointCloudHandleId?: number },
      ): Promise<void> => {
        if (target.kind === 'federated') {
          if (!dataStore || !geometryResult) {
            throw new Error('Federated model is missing its data store or geometry');
          }
          // Georef alignment against the federation anchor (resolved live from
          // the store, exactly as the former addModel finalize did).
          const referenceGeoref = findReferenceGeorefModel()?.georef ?? null;
          const parsedGeorefMutations = useViewerStore.getState().georefMutations.get(modelId);
          const parsedGeoref = extractModelGeoref(dataStore, geometryResult.coordinateInfo, parsedGeorefMutations);
          let preAlignmentPositions: Float32Array[] | undefined;
          let preAlignmentNormals: (Float32Array | undefined)[] | undefined;
          let preAlignmentCoordinateInfo: CoordinateInfo | undefined;
          let federationAlignmentStatus: FederatedModel['federationAlignmentStatus'] = 'none';
          if (referenceGeoref && parsedGeoref) {
            setProgress({ phase: 'Aligning georeferenced model', percent: 90 });
            preAlignmentPositions = geometryResult.meshes.map((mesh) => new Float32Array(mesh.positions));
            preAlignmentNormals = geometryResult.meshes.map((mesh) =>
              mesh.normals && mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined,
            );
            preAlignmentCoordinateInfo = geometryResult.coordinateInfo;
            const status = await alignGeometryToReference(geometryResult, parsedGeoref, referenceGeoref);
            federationAlignmentStatus = status;
            if (status === 'reprojected') {
              toast.info(
                `Reprojected "${file.name}" from ${parsedGeoref.projectedCRS.name} `
                + `to ${referenceGeoref.projectedCRS.name} for federation alignment.`,
              );
            } else if (status === 'failed') {
              toast.error(
                `Could not align "${file.name}" with the federation anchor — `
                + `${parsedGeoref.projectedCRS.name} → ${referenceGeoref.projectedCRS.name} `
                + 'reprojection failed. The model is shown in its own local frame and may '
                + 'appear at the wrong real-world position.',
              );
            }
          } else if (parsedGeoref) {
            federationAlignmentStatus = 'anchor';
          }

          // Federation registry: transform expressIds to globally-unique ids.
          const maxExpressId = getMaxExpressId(dataStore, geometryResult.meshes);
          const idOffset = registerModelOffset(modelId, maxExpressId);
          if (idOffset > 0) {
            for (const mesh of geometryResult.meshes) mesh.expressId = mesh.expressId + idOffset;
            for (const asset of geometryResult.pointClouds ?? []) asset.expressId = asset.expressId + idOffset;
          }
          if (idOffset > 0 && patch?.pointCloudHandleId !== undefined) {
            const renderer = getGlobalRenderer();
            if (renderer && geometryResult.pointClouds && geometryResult.pointClouds.length > 0) {
              renderer.relabelPointCloudAsset({ id: patch.pointCloudHandleId }, geometryResult.pointClouds[0].expressId);
            }
          }
          const federatedModel: FederatedModel = {
            id: modelId,
            name: target.name ?? file.name,
            ifcDataStore: dataStore,
            geometryResult,
            visible: target.visible ?? true,
            collapsed: target.collapsed ?? (useViewerStore.getState().models.size > 0),
            schemaVersion,
            loadedAt: target.loadedAt ?? Date.now(),
            fileSize: buffer.byteLength,
            sourceFile: file,
            idOffset,
            maxExpressId,
            pointCloudHandleId: patch?.pointCloudHandleId,
            preAlignmentPositions,
            preAlignmentNormals,
            preAlignmentCoordinateInfo,
            federationAlignmentStatus,
          };
          useViewerStore.getState().addModel(federatedModel);
          // Spatial index AFTER id offset + alignment (final ids + world positions)
          // and AFTER addModel so it attaches to THIS model, not the active slot.
          buildSpatialIndexForModel(geometryResult.meshes, modelId, dataStore);
          return;
        }

        // PRIMARY — unchanged from the former finalizePrimaryModel.
        let idOffset = 0;
        let maxExpressId = 0;
        if (dataStore && geometryResult) {
          maxExpressId = getMaxExpressId(dataStore, geometryResult.meshes);
          idOffset = registerModelOffset(modelId, maxExpressId);
        }

        updateModel(modelId, {
          ifcDataStore: dataStore,
          geometryResult,
          schemaVersion,
          idOffset,
          maxExpressId,
          loadState: patch?.loadState ?? 'complete',
          cacheState: patch?.cacheState ?? 'none',
          loadError: patch?.loadError ?? null,
          pointCloudHandleId: patch?.pointCloudHandleId,
        });
      };
      const getSchemaVersion = (dataStore: IfcDataStore | null): 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5' => {
        if (!dataStore) return 'IFC4';
        if (dataStore.schemaVersion === 'IFC4X3') return 'IFC4X3';
        if (dataStore.schemaVersion === 'IFC4') return 'IFC4';
        if (dataStore.schemaVersion === 'IFC5') return 'IFC5';
        return 'IFC2X3';
      };



      // Read file from disk. The browser path streams files ≥
      // STREAM_SAB_THRESHOLD directly into a SharedArrayBuffer, which avoids
      // a doubled-peak ArrayBuffer + SAB allocation when the geometry
      // pipeline copies into its own SAB. (#600)
      const fileReadStart = performance.now();
      const acquired: AcquiredBuffer = await acquireFileBuffer(file);
      // `buffer` retains its previous semantics (ArrayBuffer-shaped) for
      // every downstream consumer. When `acquired.isShared` is true the
      // backing store is a SharedArrayBuffer; downstream code only ever
      // reads bytes via `new Uint8Array(buffer)` / `new DataView(buffer)`,
      // both of which work on either backing store. The TS cast is purely
      // type-system: the runtime is identical.
      const buffer = acquired.buffer as ArrayBuffer;
      const fileReadMs = performance.now() - fileReadStart;
      console.log(`[useIfc] File: ${file.name}, size: ${fileSizeMB.toFixed(2)}MB, read in ${fileReadMs.toFixed(0)}ms${acquired.isShared ? ' (streamed→SAB)' : ''}`);

      // Detect file format (IFCX/IFC5 vs IFC4 STEP vs GLB vs LAS/LAZ)
      const pointCloudFormat = detectPointCloudFormat(file.name, buffer);
      const format = pointCloudFormat ?? detectFormat(buffer);

      // LAS / LAZ point clouds: stream chunks straight to the renderer.
      // No on-disk cache, no server upload — the data goes worker → GPU.
      if (format === 'las' || format === 'laz' || format === 'ply' || format === 'pcd' || format === 'e57' || format === 'pts' || format === 'xyz') {
        const renderer = getGlobalRenderer();
        if (!renderer) {
          setError('Renderer not initialised — try again after the viewer mounts.');
          updateModel(modelId, { loadState: 'error', loadError: 'renderer-missing' });
          setLoading(false);
          return;
        }
        setProgress({ phase: `Streaming ${format.toUpperCase()}`, percent: 5 });
        setGeometryStreamingActive(false);
        const blob = file;
        const incCount = useViewerStore.getState().incrementPointCloudAssetCount;
        const ingest = ingestPointCloud({
          format,
          blob,
          fileName: file.name,
          buffer,
          renderer,
          onProgress: setProgress,
          onAssetCountDelta: incCount,
        });
        // Expose cancellation to the UI (StatusBar shows a Cancel
        // button while this is non-null). Cleared via the
        // `clearOwnedCanceller` helper below so a later load that
        // installed its own canceller never gets clobbered by our
        // cleanup paths — the helper only nulls the store when the
        // stored function is still ours.
        const { setActiveStreamCanceller } = useViewerStore.getState();
        const cancelStream = () => ingest.streamHandle.cancel();
        setActiveStreamCanceller(cancelStream);
        const clearOwnedCanceller = () => {
          if (useViewerStore.getState().activeStreamCanceller === cancelStream) {
            setActiveStreamCanceller(null);
          }
        };
        // ingestPointCloud's onError callback already runs renderer cleanup
        // + incCount(-1); the outer catch must NOT repeat them or the
        // pointCloudAssetCount will go negative.
        try {
          await ingest.done;
        } catch (err) {
          // Bail without touching store/UI state if a newer load
          // session has already started — the more recent flow owns
          // the spinner / model record now. Free the renderer handle
          // so we don't leak the half-streamed asset.
          if (loadSessionRef.current !== currentSession) {
            console.warn(
              `[useIfc] pointcloud ingest rejected on stale session (handle=${ingest.rendererHandle.id}):`,
              err,
            );
            renderer.removePointCloudAsset(ingest.rendererHandle);
            clearOwnedCanceller();
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          // Distinguish a user-initiated abort from a real failure so
          // the status bar shows "Cancelled" instead of a scary error.
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (isAbort) {
            console.log(
              `[useIfc] pointcloud ingest cancelled (model=${modelId}, handle=${ingest.rendererHandle.id})`,
            );
            updateModel(modelId, { loadState: 'error', loadError: 'cancelled' });
            setError(null);
            setProgress({ phase: 'Cancelled', percent: 0 });
          } else {
            console.error(
              `[useIfc] pointcloud ingest failed (format=${format}, model=${modelId}):`,
              err,
            );
            updateModel(modelId, { loadState: 'error', loadError: message });
            setError(`${format.toUpperCase()} parsing failed: ${message}`);
          }
          clearOwnedCanceller();
          setLoading(false);
          return;
        }
        clearOwnedCanceller();
        if (loadSessionRef.current !== currentSession) {
          // A newer load already began. Drop our streamed asset and
          // skip every store/UI mutation so we don't overwrite the
          // newer model's state.
          renderer.removePointCloudAsset(ingest.rendererHandle);
          return;
        }
        // Primary owns the active-model slots; a federated add must not touch
        // them (finalizeModel's federated branch wires via addModel instead).
        if (target.kind === 'primary') {
          setGeometryResult(ingest.geometryResult);
          setIfcDataStore(ingest.dataStore);
        }
        await finalizeModel(ingest.dataStore, ingest.geometryResult, ingest.schemaVersion, {
          pointCloudHandleId: ingest.rendererHandle.id,
        });
        setProgress({ phase: 'Complete', percent: 100 });
        setLoading(false);
        return;
      }

      // IFCX files must be parsed client-side (server only supports IFC4 STEP)
      if (format === 'ifcx') {
        setProgress({ phase: 'Parsing IFCX (client-side)', percent: 10 });
        setGeometryStreamingActive(false);

        try {
          const result = await parseIfcxViewerModel(buffer, setProgress);
          if (target.kind === 'primary') {
            setGeometryResult(result.geometryResult);
            setIfcDataStore(result.dataStore);
          }
          await finalizeModel(result.dataStore, result.geometryResult, result.schemaVersion);

          setProgress({ phase: 'Complete', percent: 100 });
          setLoading(false);
          return;
        } catch (err: unknown) {
          if (err instanceof Error && err.message === 'overlay-only-ifcx') {
            console.warn(`[useIfc] IFCX file "${file.name}" has no geometry - this appears to be an overlay file that adds properties to a base model.`);
            console.warn('[useIfc] To use this file, load it together with a base IFCX file (select both files at once).');
            setError(`"${file.name}" is an overlay file with no geometry. Please load it together with a base IFCX file (select all files at once).`);
            updateModel(modelId, { loadState: 'error', loadError: 'overlay-only-ifcx' });
            setLoading(false);
            return;
          }
          console.error('[useIfc] IFCX parsing failed:', err);
          const message = err instanceof Error ? err.message : String(err);
          updateModel(modelId, { loadState: 'error', loadError: message });
          setError(`IFCX parsing failed: ${message}`);
          setLoading(false);
          return;
        }
      }

      // GLB files: parse directly to MeshData (no data model, geometry only)
      if (format === 'glb') {
        setProgress({ phase: 'Parsing GLB', percent: 10 });
        setGeometryStreamingActive(false);

        try {
          const result = await parseGlbViewerModel(buffer);
          if (target.kind === 'primary') {
            setGeometryResult(result.geometryResult);
            setIfcDataStore(null);
          }
          // Primary keeps the historical null data store (GLB has no entities);
          // a federated add needs the minimal store so finalizeModel can offset
          // ids + register the model (matches the old addModel GLB path).
          await finalizeModel(
            target.kind === 'federated' ? result.dataStore : null,
            result.geometryResult,
            result.schemaVersion,
          );

          setProgress({ phase: 'Complete', percent: 100 });

          setLoading(false);
          return;
        } catch (err: unknown) {
          console.error('[useIfc] GLB parsing failed:', err);
          const message = err instanceof Error ? err.message : String(err);
          updateModel(modelId, { loadState: 'error', loadError: message });
          setError(`GLB parsing failed: ${message}`);
          setLoading(false);
          return;
        }
      }

      // Cache key uses filename + size + content fingerprint + format version
      // Fingerprint prevents collisions for different files with the same name and size
      const fingerprint = computeFastFingerprint(buffer);
      // Desktop Tauri cache commands only accept [A-Za-z0-9_-], so keep the
      // persisted key filename-safe and independent of the original filename.
      // Pin to the cache FORMAT_VERSION so a format bump invalidates stale
      // entries (e.g. v5 added the geometryClass tag the Model/Types switch
      // needs); a manual literal here silently kept serving incompatible data.
      const cacheKey = `ifc-${buffer.byteLength}-${fingerprint}-v${FORMAT_VERSION}`;

      // Cache + server are PRIMARY-ONLY: a federated add is WASM-only with no
      // cache/server round-trip (matches the former parseStepBufferViewerModel).
      if (target.kind === 'primary' && buffer.byteLength >= CACHE_SIZE_THRESHOLD) {
        setProgress({ phase: 'Checking cache', percent: 5 });
        const cacheResult = await getCached(cacheKey);
        if (cacheResult) {
          // Pass the freshly read file buffer as the source fallback: the
          // desktop cache doesn't persist a sourceBuffer, and without one the
          // restored store can't carry the lazy entity accessors.
          const cacheLoadResult = await loadFromCache(cacheResult, file.name, cacheKey, buffer);
          if (cacheLoadResult.success) {
            const state = useViewerStore.getState();
            await finalizeModel(state.ifcDataStore, state.geometryResult, getSchemaVersion(state.ifcDataStore), {
              loadState: 'complete',
              cacheState: 'hit',
            });
            console.log(`[useIfc] TOTAL LOAD TIME (from cache): ${(performance.now() - totalStartTime).toFixed(0)}ms`);
            setLoading(false);
            return;
          }
        }
      }

      // Try server parsing first (enabled by default for multi-core performance)
      // Only for IFC4 STEP files (server doesn't support IFCX). Native
      // file handles (Tauri) don't have an HTTP-uploadable body, so skip
      // the server path and fall through to the WASM loader.
      if (target.kind === 'primary' && format === 'ifc' && USE_SERVER && SERVER_URL && SERVER_URL !== '') {
        // Pass buffer directly - server uses File object for parsing, buffer is only for size checks
        const serverSuccess = await loadFromServer(file, buffer, () => loadSessionRef.current !== currentSession);
        if (serverSuccess) {
          const state = useViewerStore.getState();
          await finalizeModel(state.ifcDataStore, state.geometryResult, getSchemaVersion(state.ifcDataStore));
          console.log(`[useIfc] TOTAL LOAD TIME (server): ${(performance.now() - totalStartTime).toFixed(0)}ms`);
          setLoading(false);
          return;
        }
        // Server not available - continue with local WASM (no error logging needed)
      } else if (format === 'unknown') {
      }

      // Using local WASM parsing
      setProgress({ phase: 'Starting geometry streaming', percent: 10 });
      // Global streaming flag is a PRIMARY (active-model) concern; a federated
      // add must not toggle it (the former federated path never did).
      if (target.kind === 'primary') {
        setGeometryStreamingActive(true);
      }

      // Initialize geometry processor first (WASM init is fast if already loaded)
      const mergeLayersAtLoad = useViewerStore.getState().mergeLayers;
      const geometryProcessor = new GeometryProcessor({
        quality: GeometryQuality.Balanced,
        preferNative: false,
        // Issue #540: snapshot at load time so the WASM bridge applies
        // the flag before the first parseMeshes* call.
        mergeLayers: mergeLayersAtLoad,
      });
      await geometryProcessor.init();
      // Issue #924: enable RTC-invariant per-entity geometry fingerprints so
      // the model-compare feature can detect geometry changes. The hash rides
      // on each MeshData.geometryHash (and through the worker pool); cost is
      // the O(verts) quantized hash, negligible next to tessellation.
      geometryProcessor.enableGeometryHashes();

      // Allocate (or reuse) a SharedArrayBuffer so the parser worker and
      // the geometry workers read the same memory zero-copy. When
      // `acquireFileBuffer` already streamed the file directly into a SAB
      // (large-file entry path, issue #600), reuse it — no second copy.
      // `WorkerParser.isSupported()` rolls together: COI enabled, SAB
      // available, AND TextDecoder accepts SAB-backed views (Firefox fails
      // the third check; we skip the worker path entirely there so the
      // SAB allocation isn't wasted).
      const useParserWorker = WorkerParser.isSupported();
      let sharedSource: SharedArrayBuffer | null = null;
      if (useParserWorker) {
        if (acquired.isShared && acquired.buffer instanceof SharedArrayBuffer) {
          // acquireFileBuffer already streamed bytes into a SAB. Reuse it.
          sharedSource = acquired.buffer;
        } else {
          // Smaller files (or non-COI) took the `await file.arrayBuffer()`
          // branch — make a SAB copy so the parser worker can read it.
          sharedSource = new SharedArrayBuffer(buffer.byteLength);
          new Uint8Array(sharedSource).set(new Uint8Array(buffer));
        }
        memoryAccounting.setSourceBytes(buffer.byteLength);
      }

      // Data model parsing runs IN PARALLEL with geometry streaming.
      // Default path: parser runs in a Web Worker via WorkerParser, both
      // workers + main share the same SharedArrayBuffer source, and the
      // main thread never blocks on parse.
      // Fallback: in-process IfcParser.parseColumnar (the previous default)
      // — used when cross-origin isolation is missing or the worker spawn
      // fails (auto-fallback inside the catch).
      let resolveDataStore: (dataStore: IfcDataStore) => void;
      let rejectDataStore: (err: unknown) => void;
      const dataStorePromise = new Promise<IfcDataStore>((resolve, reject) => {
        resolveDataStore = resolve;
        rejectDataStore = reject;
      });

      const onPartialDataStore = (partialStore: IfcDataStore) => {
        if (loadSessionRef.current !== currentSession) return;
        if (spatialReadyMs === null) {
          spatialReadyMs = performance.now() - totalStartTime;
          console.log(`[useIfc] Spatial tree ready for ${file.name} at ${spatialReadyMs.toFixed(0)}ms`);
        }
        if (partialStore.spatialHierarchy && partialStore.spatialHierarchy.storeyHeights.size === 0 && partialStore.spatialHierarchy.storeyElevations.size > 1) {
          const calculatedHeights = calculateStoreyHeights(partialStore.spatialHierarchy.storeyElevations);
          for (const [storeyId, height] of calculatedHeights) {
            partialStore.spatialHierarchy.storeyHeights.set(storeyId, height);
          }
        }
        // PRIMARY only: setIfcDataStore writes the ACTIVE model. A federated
        // add must not touch model #1's store — it wires its own via
        // finalizeModel → addModel once dataStorePromise resolves.
        if (target.kind === 'primary') setIfcDataStore(partialStore);
      };

      const onFullDataStore = (dataStore: IfcDataStore) => {
        if (loadSessionRef.current !== currentSession) return;
        metadataCompleteMs = performance.now() - totalStartTime;
        if (dataStore.spatialHierarchy && dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
          const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
          for (const [storeyId, height] of calculatedHeights) {
            dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
          }
        }
        // PRIMARY only (active-model write); federated wires via finalizeModel.
        // resolveDataStore stays unconditional so the federated finalizePromise
        // still resolves and registers the model.
        if (target.kind === 'primary') setIfcDataStore(dataStore);
        console.log(`[useIfc] Data model parsing complete for ${file.name}: ${metadataCompleteMs.toFixed(0)}ms`);
        memoryAccounting.endPhase('parser-worker');
        memoryAccounting.recordPhase({ phase: 'parser-complete' });
        resolveDataStore(dataStore);
      };

      const runMainThreadParser = async (): Promise<IfcDataStore> => {
        // Same `wasmApi` heuristic as before — desktop loads cannot share
        // the geometry processor's WASM instance with the parser without
        // risking corruption.
        const parserWasmApi = geometryProcessor.getApi();
        return new IfcParser().parseColumnar(buffer, {
          wasmApi: parserWasmApi ?? undefined,
          onSpatialReady: onPartialDataStore,
        });
      };

      // Hoisted so the geometry pre-pass's `onEntityIndex` callback can
      // hand the SAB triple to the same worker the parser is running in.
      // Receiving the index lets the parser worker skip its own ~10 s
      // `scanEntitiesFastBytes` call — the streaming pre-pass already
      // walked the file and built the same index.
      let workerParserInstance: WorkerParser | null = null;

      // The geometry pre-pass only emits `entity-index` on the parallel
      // streaming path inside `processAdaptive`. Files smaller than the
      // sync threshold (2 MB) and the desktop-stable path don't fire it
      // — gate `waitForEntityIndex` so the parser doesn't hang.
      const ADAPTIVE_SYNC_THRESHOLD_MB = 2;
      const geometryWillEmitEntityIndex =
        useParserWorker
        && fileSizeMB >= ADAPTIVE_SYNC_THRESHOLD_MB;

      const startDataModelParsing = () => {
        metadataStartMs = performance.now() - totalStartTime;
        console.log(`[useIfc] Data model parsing start for ${file.name}: ${metadataStartMs.toFixed(0)}ms (${useParserWorker ? 'worker' : 'main-thread'})`);
        memoryAccounting.beginPhase('parser-worker');
        memoryAccounting.recordPhase({ phase: 'parser-start' });

        const workerAttempt = (): Promise<IfcDataStore> => {
          if (!useParserWorker || !sharedSource) {
            return Promise.reject(new Error('parser worker disabled (no SAB / native file)'));
          }
          // NOTE: `deferPropertyAtomIndex` is not enabled here. The current
          // implementation in `columnar-parser.ts` calls
          // `entityRefs.filter(...)` to split property atoms out of the
          // primary index, which costs more on a 14 M-entity file (~3 s
          // for the filter pass) than the index-build time it saves.
          // Re-enable once the categorization loop builds the two
          // ref arrays inline so there is no second O(N) walk.
          const worker = new WorkerParser();
          workerParserInstance = worker;
          return worker.parseColumnar(sharedSource, {
            onSpatialReady: onPartialDataStore,
            // Hold the parser's WASM scan until the pre-pass hands over
            // the entity index — but only when we know the geometry
            // path will actually emit one (parallel-streaming branch).
            waitForEntityIndex: geometryWillEmitEntityIndex,
            onMemorySnapshot: (snapshot) => {
              if (snapshot.jsHeapBytes !== undefined) {
                memoryAccounting.recordWorkerMemory('parser', snapshot.jsHeapBytes);
              }
              memoryAccounting.recordPhase({
                phase: 'parser-transport',
                transportBytes: snapshot.transportBytes,
              });
            },
          });
        };

        workerAttempt()
          .catch((err) => {
            console.warn('[useIfc] Parser worker failed, falling back to main-thread parse:', err);
            memoryAccounting.recordPhase({ phase: 'parser-worker-fallback' });
            return runMainThreadParser();
          })
          .then(onFullDataStore)
          .catch((err) => {
            metadataFailedMs = performance.now() - totalStartTime;
            console.error('[useIfc] Data model parsing failed:', err);
            console.log(`[useIfc] Data model parsing failed for ${file.name}: ${metadataFailedMs.toFixed(0)}ms`);
            memoryAccounting.recordPhase({ phase: 'parser-failed' });
            rejectDataStore(err);
          });
      };

      // Start data model parsing IMMEDIATELY — runs in parallel with geometry.
      setTimeout(startDataModelParsing, 0);

      // Use adaptive processing: sync for small files, streaming for large files
      let estimatedTotal = 0;
      let totalMeshes = 0;
      const allMeshes: MeshData[] = []; // Collect all meshes for BVH building
      let finalCoordinateInfo: CoordinateInfo | null = null;
      // Capture RTC offset from WASM for proper multi-model alignment
      let capturedRtcOffset: { x: number; y: number; z: number } | null = null;
      // Track all deferred style updates so cache data always uses final colors.
      const cumulativeColorUpdates = new Map<number, [number, number, number, number]>();
      let firstAppendGeometryBatchMs: number | null = null;
      let firstVisibleGeometryMs: number | null = null;
      let streamCompleteMs: number | null = null;
      let metadataStartMs: number | null = null;
      let spatialReadyMs: number | null = null;
      let metadataCompleteMs: number | null = null;
      let metadataFailedMs: number | null = null;

      // Clear existing geometry result — PRIMARY only (federated must not
      // disturb the active model's geometry).
      if (target.kind === 'primary') {
        setGeometryResult(null);
      }

      // Timing instrumentation
      let batchCount = 0;
      let lastTotalMeshes = 0;

      // OPTIMIZATION: Accumulate meshes and batch state updates
      // First batch renders immediately, then accumulate for throughput
      // Adaptive interval: larger files get less frequent updates to reduce React re-render overhead
      let pendingMeshes: MeshData[] = [];
      let lastRenderTime = 0;
      const RENDER_INTERVAL_MS = getRenderIntervalMs(fileSizeMB);
      const markFirstVisibleGeometry = () => {
        if (firstVisibleGeometryMs !== null) return;
        requestAnimationFrame(() => {
          if (firstVisibleGeometryMs !== null || loadSessionRef.current !== currentSession) return;
          firstVisibleGeometryMs = performance.now() - totalStartTime;
          console.log(`[useIfc] First visible geometry for ${file.name}: ${firstVisibleGeometryMs.toFixed(0)}ms`);
        });
      };

      // Declare at function scope so the catch block can always reach it.
      let closeGeometryIterator: (() => Promise<void>) | null = null;
      // The background finalize (spatial index / cache for primary; align +
      // addModel for federated). Primary leaves it running in the background
      // for a fast first frame; federated MUST await it so the model is
      // registered before loadFile resolves (loadFilesSequentially relies on it).
      let finalizePromise: Promise<void> | null = null;

      try {
        // Use dynamic batch sizing for optimal throughput
        const dynamicBatchConfig = getDynamicBatchConfig(fileSizeMB);
        memoryAccounting.beginPhase('geometry');
        // When the parser worker is in use, hand the geometry workers the
        // same SAB so we don't pay the file-bytes copy twice.
        const geometryView = sharedSource ? new Uint8Array(sharedSource) : new Uint8Array(buffer);
        const geometryEvents = geometryProcessor.processAdaptive(geometryView, {
              sizeThreshold: 2 * 1024 * 1024, // 2MB threshold
              batchSize: dynamicBatchConfig, // Dynamic batches: small first, then large
              existingSab: sharedSource ?? undefined,
              // Federated adds share the anchor's RTC origin so all models sit in
              // one coordinate space (pixel-perfect alignment, no post-shift).
              sharedRtcOffset: target.kind === 'federated' ? target.sharedRtcOffset : undefined,
              // Hand the streaming pre-pass's entity index to the parser
              // worker so it skips a duplicate ~10 s WASM scan. Safe even
              // when the parser falls back to main-thread (instance is
              // null then; the callback no-ops).
              onEntityIndex: (ids, starts, lengths) => {
                if (workerParserInstance) {
                  workerParserInstance.setEntityIndex(ids, starts, lengths);
                }
              },
            });
        const geometryIterator = geometryEvents[Symbol.asyncIterator]();
        let geometryIteratorClosed = false;
        closeGeometryIterator = async () => {
          if (geometryIteratorClosed || typeof geometryIterator.return !== 'function') return;
          geometryIteratorClosed = true;
          // Bound the shutdown: `return()` cannot interrupt a generator parked
          // on a stalled worker await, so an unbounded await would re-wedge on
          // the very stall the watchdog escaped. See boundedIteratorReturn.
          await boundedIteratorReturn(geometryIterator);
        };

        while (true) {
          const watchdogMs = getGeometryStreamWatchdogMs(
            false,
            batchCount,
            fileSizeMB,
          );
          let watchdogId: ReturnType<typeof globalThis.setTimeout> | null = null;
          const nextResult = await Promise.race([
            geometryIterator.next(),
            new Promise<never>((_, reject) => {
              watchdogId = globalThis.setTimeout(() => {
                reject(new Error(
                  `Geometry stream stalled after ${watchdogMs}ms while loading ${file.name}. ` +
                  `Last rendered meshes: ${lastTotalMeshes}.`
                ));
              }, watchdogMs);
            }),
          ]);
          if (watchdogId !== null) {
            globalThis.clearTimeout(watchdogId);
          }

          if (nextResult.done) {
            await closeGeometryIterator();
            break;
          }

          const event = nextResult.value;
          const eventReceived = performance.now();

          switch (event.type) {
            case 'start':
              estimatedTotal = event.totalEstimate;
              break;
            case 'model-open':
              setProgress({ phase: 'Processing geometry', percent: 50 });
              break;
            case 'progress':
              // Liveness heartbeat from the parallel pipeline. Receiving
              // any event resets the watchdog implicitly because the next
              // loop iteration re-creates the timer; nothing to do here.
              break;
            case 'colorUpdate': {
              // Accumulate color updates locally during streaming.
              // We apply them in a single pass at 'complete' instead of
              // calling updateMeshColors() per event (which triggers a
              // React reconciliation each time + O(n) scan over all meshes).
              for (const [expressId, color] of event.updates) {
                cumulativeColorUpdates.set(expressId, color);
              }
              // Keep local mesh snapshots in sync for cache serialization.
              applyColorUpdatesToMeshes(allMeshes, event.updates);
              applyColorUpdatesToMeshes(pendingMeshes, event.updates);
              break;
            }
            case 'rtcOffset': {
              // Capture RTC offset from WASM for multi-model alignment
              if (event.hasRtc) {
                capturedRtcOffset = event.rtcOffset;
              }
              break;
            }
            case 'workerMemory': {
              // Aggregated by memoryAccounting for per-load summaries.
              memoryAccounting.recordWorkerMemory(`geom-${event.workerIndex}`, event.wasmHeapBytes);
              memoryAccounting.addGeometryBytes(event.meshBytes);
              break;
            }
            case 'batch': {
              batchCount++;

              // Track time to first geometry
              if (batchCount === 1) {
              }

              // Collect meshes for BVH building (use loop to avoid stack overflow with large batches)
              for (let i = 0; i < event.meshes.length; i++) allMeshes.push(event.meshes[i]);
              finalCoordinateInfo = event.coordinateInfo ?? null;
              totalMeshes = event.totalSoFar;
              lastTotalMeshes = event.totalSoFar;

              if (target.kind === 'primary') {
                // Accumulate meshes for batched rendering
                for (let i = 0; i < event.meshes.length; i++) pendingMeshes.push(event.meshes[i]);

                // FIRST BATCH: Render immediately for fast first frame
                // SUBSEQUENT: Throttle to reduce React re-renders
                const timeSinceLastRender = eventReceived - lastRenderTime;
                const shouldRender = batchCount === 1 || timeSinceLastRender >= RENDER_INTERVAL_MS;

                if (shouldRender && pendingMeshes.length > 0) {
                  if (firstAppendGeometryBatchMs === null) {
                    firstAppendGeometryBatchMs = performance.now() - totalStartTime;
                    console.log(`[useIfc] First appendGeometryBatch for ${file.name}: ${firstAppendGeometryBatchMs.toFixed(0)}ms`);
                  }
                  appendGeometryBatch(pendingMeshes, event.coordinateInfo);
                  pendingMeshes = [];
                  lastRenderTime = eventReceived;
                  markFirstVisibleGeometry();

                  // Update progress
                  const progressPercent = 50 + Math.min(45, (totalMeshes / Math.max(estimatedTotal / 10, totalMeshes)) * 45);
                  setProgress({
                    phase: `Rendering geometry (${totalMeshes} meshes)`,
                    percent: progressPercent
                  });
                }
              } else {
                // Federated add: accumulate into allMeshes only (done above) and
                // surface progress — it paints atomically at completion via
                // finalizeModel's addModel, never touching the active slot.
                setProgress({
                  phase: `Processing geometry (${totalMeshes} meshes)`,
                  percent: 10 + Math.min(80, (allMeshes.length / 1000) * 0.8),
                });
              }

              break;
            }
            case 'complete':
              streamCompleteMs = performance.now() - totalStartTime;
              // Flush remaining pending meshes — PRIMARY only. A federated add
              // never pushed to pendingMeshes; it paints atomically at finalize.
              if (target.kind === 'primary' && pendingMeshes.length > 0) {
                if (firstAppendGeometryBatchMs === null) {
                  firstAppendGeometryBatchMs = performance.now() - totalStartTime;
                  console.log(`[useIfc] First appendGeometryBatch for ${file.name}: ${firstAppendGeometryBatchMs.toFixed(0)}ms`);
                }
                appendGeometryBatch(pendingMeshes, event.coordinateInfo);
                pendingMeshes = [];
                markFirstVisibleGeometry();
              }

              finalCoordinateInfo = event.coordinateInfo ?? null;

              // Store captured RTC offset in coordinate info for multi-model alignment.
              if (finalCoordinateInfo && capturedRtcOffset) {
                finalCoordinateInfo.wasmRtcOffset = capturedRtcOffset;
              }

              if (target.kind === 'primary') {
                // Active-model writes — PRIMARY only. Federated meshes already
                // carry colours (applied during streaming) and their coordinate
                // info rides the geometryResult handed to addModel at finalize.
                if (cumulativeColorUpdates.size > 0) {
                  updateMeshColors(cumulativeColorUpdates);
                }
                updateCoordinateInfo(finalCoordinateInfo);
              }

              setProgress({ phase: 'Complete', percent: 100 });
              memoryAccounting.endPhase('geometry');
              memoryAccounting.recordPhase({ phase: 'geometry-complete' });
              console.log(memoryAccounting.formatSummary());
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (loadSessionRef.current === currentSession && target.kind === 'primary') {
                setGeometryStreamingActive(false);
              }
              console.log(`[useIfc] Geometry streaming complete: ${batchCount} batches, ${lastTotalMeshes} meshes`);
              console.log(`[useIfc] Stream complete for ${file.name}: ${streamCompleteMs.toFixed(0)}ms`);

              // Finalize once the data model is ready (parses in parallel).
              finalizePromise = dataStorePromise.then(async dataStore => {
                // Guard: skip if user loaded a new file since this load started
                if (loadSessionRef.current !== currentSession) return;

                if (target.kind === 'federated') {
                  // Build the model's geometryResult from the accumulated meshes —
                  // federated never streamed into the active slot — and hand it to
                  // finalizeModel, which aligns, offsets ids, builds the spatial
                  // index, and registers the model via addModel. NOT cached (the
                  // former federated path never cached); allMeshes stays alive as
                  // the model's geometryResult.meshes, so it is NOT cleared.
                  applyColorUpdatesToMeshes(allMeshes, cumulativeColorUpdates);
                  const federatedGeometry: GeometryResult = {
                    meshes: allMeshes,
                    totalVertices: allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0),
                    totalTriangles: allMeshes.reduce((sum, m) => sum + m.indices.length / 3, 0),
                    coordinateInfo: finalCoordinateInfo ?? createCoordinateInfo(calculateMeshBounds(allMeshes).bounds),
                  };
                  await finalizeModel(dataStore, federatedGeometry, getSchemaVersion(dataStore), {
                    loadState: 'complete',
                  });
                  return;
                }

                await finalizeModel(dataStore, useViewerStore.getState().geometryResult, getSchemaVersion(dataStore), {
                  loadState: 'complete',
                  cacheState: buffer.byteLength >= CACHE_SIZE_THRESHOLD ? 'writing' : 'none',
                });
                // Build spatial index from meshes in time-sliced chunks (non-blocking).
                // Previously this was synchronous inside requestIdleCallback, blocking
                // the main thread for seconds on 200K+ mesh models (190M+ float reads
                // for bounds computation alone).
                buildSpatialIndexGuarded(allMeshes, dataStore, setIfcDataStore);

                // Cache the result in the background (files between 10 MB and 150 MB).
                // Files above CACHE_MAX_SOURCE_SIZE are not cached because the
                // source buffer is required for on-demand property/quantity
                // extraction, spatial hierarchy elevations, and IFC re-export.
                // Caching without it would silently degrade those features.
                if (
                  buffer.byteLength >= CACHE_SIZE_THRESHOLD &&
                  buffer.byteLength <= CACHE_MAX_SOURCE_SIZE &&
                  allMeshes.length > 0 &&
                  finalCoordinateInfo
                ) {
                  // Final safety pass so cache always contains post-style colors.
                  applyColorUpdatesToMeshes(allMeshes, cumulativeColorUpdates);
                  const geometryData: GeometryData = {
                    meshes: allMeshes,
                    totalVertices: allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0),
                    totalTriangles: allMeshes.reduce((sum, m) => sum + m.indices.length / 3, 0),
                    coordinateInfo: finalCoordinateInfo,
                  };
                  await saveToCache(cacheKey, dataStore, geometryData, buffer, file.name);
                }

                // Release closure references to MeshData objects after a delay.
                // buildSpatialIndexGuarded starts an async spatial index build that
                // reads from allMeshes — clearing immediately would corrupt it.
                // The store's geometryResult.meshes still holds references to the same
                // objects, so they remain alive for rendering/visibility.
                setTimeout(() => {
                  allMeshes.length = 0;
                  cumulativeColorUpdates.clear();
                }, 5000);
              }).catch(err => {
                // Data model parsing failed - spatial index and caching skipped
                console.warn('[useIfc] Skipping spatial index/cache - data model unavailable:', err);
                const message = err instanceof Error ? err.message : String(err);
                if (target.kind === 'federated') {
                  // No placeholder model exists for a federated add (it is only
                  // registered on success via finalizeModel→addModel), so
                  // updateModel would no-op and the failure would vanish —
                  // addModel just returns null. Surface it to the user instead.
                  toast.error(`Failed to load "${file.name}": ${message}`);
                } else {
                  updateModel(modelId, {
                    loadState: 'error',
                    loadError: message,
                  });
                }
              });
              break;
          }
        }
        await closeGeometryIterator?.();
      } catch (err) {
        // Close the geometry iterator to release WASM resources on failure.
        if (closeGeometryIterator) {
          await closeGeometryIterator();
        }
        // The parser worker may be parked in `waitForEntityIndex` (the aborted
        // geometry pre-pass would have unblocked it); it self-terminates on its
        // own watchdog. Swallow the now-orphaned dataStorePromise rejection so
        // it doesn't surface as an unhandled rejection.
        void dataStorePromise.catch(() => {});
        if (loadSessionRef.current !== currentSession) return;
        console.error('[useIfc] Error in processing:', err);
        setError(err instanceof Error ? err.message : 'Unknown error during geometry processing');
        setLoading(false);
        setGeometryStreamingActive(false);
        return;
      }

      if (loadSessionRef.current !== currentSession) return;

      // Federated adds register the model inside finalizePromise (georef align
      // → id offset → spatial index → addModel). Await it so loadFile resolves
      // only AFTER the model is in the map — loadFilesSequentially loads the
      // next file serially and relies on this ordering for id-offset assignment.
      if (target.kind === 'federated' && finalizePromise) {
        await finalizePromise;
      }

      if (firstVisibleGeometryMs === null && firstAppendGeometryBatchMs !== null) {
        await new Promise<void>((resolve) => {
          const fallbackTimer = globalThis.setTimeout(() => {
            if (firstVisibleGeometryMs === null && loadSessionRef.current === currentSession) {
              firstVisibleGeometryMs = firstAppendGeometryBatchMs;
              console.log(`[useIfc] First visible geometry for ${file.name}: ${firstVisibleGeometryMs.toFixed(0)}ms`);
            }
            resolve();
          }, 250);
          requestAnimationFrame(() => {
            globalThis.clearTimeout(fallbackTimer);
            if (firstVisibleGeometryMs === null && loadSessionRef.current === currentSession) {
              firstVisibleGeometryMs = performance.now() - totalStartTime;
              console.log(`[useIfc] First visible geometry for ${file.name}: ${firstVisibleGeometryMs.toFixed(0)}ms`);
            }
            resolve();
          });
        });
      }

      const totalElapsedMs = performance.now() - totalStartTime;
      const totalVertices = allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
      console.log(
        `[ifc-lite] ${file.name} (${fileSizeMB.toFixed(1)}MB) → ${allMeshes.length} meshes, ${(totalVertices / 1000).toFixed(0)}k verts in ${(totalElapsedMs / 1000).toFixed(1)}s`
      );
      setLoading(false);
      setGeometryStreamingActive(false);
    } catch (err) {
      if (loadSessionRef.current !== currentSession) return;
      updateModel(modelId, {
        loadState: 'error',
        loadError: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
      setGeometryStreamingActive(false);
    }
  }, [setLoading, setGeometryStreamingActive, setError, setProgress, setIfcDataStore, setGeometryResult, appendGeometryBatch, updateMeshColors, updateCoordinateInfo, loadFromCache, saveToCache, loadFromServer]);

  return { loadFile };
}

export default useIfcLoader;
