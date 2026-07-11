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

import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { getViewerStoreApi, useViewerStore, type FederatedModel } from '@/store';
import { getGeomWorkerOverride, resolveLoadTessellationTier, isMeshOnlyCacheEnabled } from '../store/constants.js';
import { planCacheWrite, decideMeshOnlyCacheHit } from './cacheTier.js';
import { computeSourceFingerprint } from './sourceFingerprint.js';
import { computeFullSourceHash } from '../utils/sourceContentHash.js';
import { IfcParser, detectFormat, unwrapIfcZip, type IfcDataStore } from '@ifc-lite/parser';
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
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import { type GeometryData } from '@ifc-lite/cache';

import { SERVER_URL, USE_SERVER, CACHE_SIZE_THRESHOLD, CACHE_MAX_SOURCE_SIZE, CACHE_MESH_ONLY_MAX_SIZE, getDynamicBatchConfig } from '../utils/ifcConfig.js';
import {
  calculateMeshBounds,
  createCoordinateInfo,
  getRenderIntervalMs,
  calculateStoreyHeights,
} from '../utils/localParsingUtils.js';
import { applyColorUpdatesToMeshes } from './meshColorUpdates.js';

// Cache hook
import { useIfcCache, getCached, deleteCached } from './useIfcCache.js';

// Server hook
import { useIfcServer } from './useIfcServer.js';

import { getMaxExpressId, parseGlbViewerModel, parseIfcxViewerModel } from './ingest/viewerModelIngest.js';
import { boundedIteratorReturn } from './ingest/streamCleanup.js';
import { detectPointCloudFormat, ingestPointCloud } from './ingest/pointCloudIngest.js';
import { getGlobalRenderer } from './useBCF.js';
import { extractModelGeoref, alignGeometryToReference, findReferenceGeorefModel } from './ingest/federationAlign.js';
import { toast } from '../components/ui/toast.js';
import { posthog } from '../lib/analytics.js';
import { reportRenderStats } from '../utils/renderStatsReport.js';
import { classifyLoadError, formatLoadError } from '../lib/load-errors.js';

/**
 * The skip-tiny-cuts flag is no longer a hard constant: it is derived per-load
 * from the user's geometry-fidelity mode (`fast` vs `exact`, see
 * `resolveLoadTessellationTier` / store `geometryMode`). In `fast` mode the
 * on-screen load skips sub-10% detail boolean cuts (steel copes/notches, minor
 * recesses) for fast first paint on boolean-heavy models (#1286) and may auto-
 * lower tessellation density on heavy models; in `exact` mode every cut runs at
 * full density.
 *
 * IMPORTANT: in `fast` mode this is NOT display-only — the cached
 * `geometryResult.meshes` are what exports (GLB/IFC5/CSV) and in-viewer
 * measure/section read, so they reflect the preview too. That is intentional and
 * visible: the user picked `fast`. For full-fidelity exports/measurement they
 * switch to `exact` and reload (same flow as Merge Layers). The cache key folds
 * the derived flag + tier so a preview cache is never served where `exact` is
 * expected, and vice versa.
 */

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
    appendInstancedShards,
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
    appendInstancedShards: s.appendInstancedShards,
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

  // Latest `loadFile`, so the background revalidation can reload without being a
  // dependency of `loadFile` itself (avoids a definition cycle). Kept current by
  // the effect below.
  const loadFileRef = useRef<((file: File, target?: LoadTarget) => Promise<void>) | null>(null);

  /**
   * Background revalidation for a SERVED source-decoupled (mesh-only) cache hit:
   * confirm the TRUE full-file hash of the fresh buffer matches what was stored
   * at write. The mtime guard already rejected any normal on-disk edit before
   * serving; this closes the deliberate mtime-PRESERVED in-place edit (a GUID or
   * same-width coordinate patch the O(1) spread key can't see) that the mtime
   * guard alone would miss. On mismatch: purge the stale entry and auto-reload
   * (a full reparse) with a notice. Runs off the main thread (Web Crypto), so it
   * never blocks the instant hit it follows.
   */
  const revalidateSourceDecoupledHit = useCallback(async (args: {
    file: File;
    target: LoadTarget;
    buffer: ArrayBufferLike;
    cacheKey: string;
    expectedHash: string;
    session: number;
  }): Promise<void> => {
    try {
      const freshHash = await computeFullSourceHash(args.buffer);
      // Web Crypto unavailable → can't revalidate; the mtime guard already vetted
      // this hit, so leave it served rather than churning a reload.
      if (freshHash === null) return;
      if (freshHash === args.expectedHash) return; // validated: byte-identical source

      console.warn(`[useIfc] source-decoupled cache was stale (full-hash mismatch) — reloading "${args.file.name}"`);
      await deleteCached(args.cacheKey);
      // A newer load superseded this one: the entry is purged; don't yank the
      // user off whatever they loaded next.
      if (loadSessionRef.current !== args.session) return;
      toast.info(`"${args.file.name}" changed since it was cached — reloading with the current file.`);
      await loadFileRef.current?.(args.file, args.target);
    } catch (err) {
      console.warn('[useIfc] background cache revalidation failed', err);
    }
  }, []);

  const loadFile = useCallback(async (
    file: File,
    target: LoadTarget = { kind: 'primary' },
    options?: { sourceHandle?: FileSystemFileHandle },
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

    // Cold-storage residency (issue #1682 phase 3b): any new load invalidates
    // the previous entry-backed provider — a primary load replaces the model,
    // and a federated add's geometry is not in the primary's cache entry (a
    // cold restore could not serve it, so the tier must switch off).
    // loadFromCache re-wires it for v13 primary hits. A FEDERATED add must
    // first drain existing cold buckets back to warm while the provider still
    // exists, or the primary's cold chunks would be stranded shells (their
    // geometry unreachable). Primary loads skip the drain: the scene is
    // replaced wholesale anyway.
    {
      const scene = getGlobalRenderer()?.getScene();
      if (scene) {
        if (target.kind === 'federated') {
          await scene.drainColdTier().catch((err) =>
            console.warn('[useIfc] cold-tier drain before federated add failed:', err));
        }
        scene.setColdGeometryProvider(null);
      }
    }

    // Track total elapsed time for complete user experience
    const totalStartTime = performance.now();

    try {
      // Reset all viewer state before loading new file — PRIMARY ONLY. A
      // federated add must never wipe model #1; it joins the existing map.
      if (target.kind === 'primary') {
        resetViewerState();
        clearAllModels();
        // A non-federated load has no layer stack behind it (#1717).
        useViewerStore.getState().clearLayerStack();
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
          sourceHandle: options?.sourceHandle,
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
            sourceHandle: options?.sourceHandle,
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



      // Detect point clouds from a small head slice FIRST. Point clouds
      // (E57/LAS/LAZ/PLY/PCD/PTS/XYZ) stream from the Blob in bounded windows
      // and must NOT be read whole into a (Shared)ArrayBuffer — a multi-GB
      // scan dies with "Array buffer allocation failed" on that single
      // allocation, before the streaming decoder ever runs. Magic-byte /
      // extension detection only needs the first few bytes. Only IFC / GLB /
      // IFCX actually need the full buffer.
      const headBuf = await file.slice(0, 4096).arrayBuffer();
      const pointCloudFormat = detectPointCloudFormat(file.name, headBuf);

      // The browser path streams files ≥ STREAM_SAB_THRESHOLD directly into a
      // SharedArrayBuffer, avoiding a doubled-peak ArrayBuffer + SAB allocation
      // when the geometry pipeline copies into its own SAB (#600). For point
      // clouds we keep `acquired`/`buffer` as a cheap head stand-in — the PC
      // ingest path uses the Blob + file.size, never this buffer.
      const fileReadStart = performance.now();
      const acquired: AcquiredBuffer = pointCloudFormat
        ? { buffer: headBuf, view: new Uint8Array(headBuf), isShared: false }
        : await acquireFileBuffer(file);
      // `buffer` retains its previous semantics (ArrayBuffer-shaped) for
      // every downstream consumer. When `acquired.isShared` is true the
      // backing store is a SharedArrayBuffer; downstream code only ever
      // reads bytes via `new Uint8Array(buffer)` / `new DataView(buffer)`,
      // both of which work on either backing store. The TS cast is purely
      // type-system: the runtime is identical.
      let buffer = acquired.buffer as ArrayBuffer;
      const fileReadMs = performance.now() - fileReadStart;
      console.log(
        `[useIfc] File: ${file.name}, size: ${fileSizeMB.toFixed(2)}MB` +
          (pointCloudFormat
            ? ` — point cloud, streaming from Blob (no whole-file read)`
            : `, read in ${fileReadMs.toFixed(0)}ms${acquired.isShared ? ' (streamed→SAB)' : ''}`),
      );

      // Transparent .ifcZIP unwrap (issue #1494) — cheap magic-byte no-op for
      // an ordinary file. Skipped for point clouds: those never reach here
      // with the full buffer (streamed straight from the Blob). The server
      // client uploads the original `file` object (still zipped), but the
      // server unwraps `.ifcZIP` itself (apps/server extract_file), so a zipped
      // upload can still take the server fast-path; the local WASM path
      // consumes the now-unwrapped `buffer`.
      if (!pointCloudFormat) {
        buffer = await unwrapIfcZip(buffer);
      }

      // IFCX/IFC5 vs IFC4 STEP vs GLB resolved from the full buffer; point
      // cloud format was already resolved from the head slice above.
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
        // WebGPU init is async (Viewport calls `renderer.init()` on mount).
        // Dropping a point cloud BEFORE an IFC — i.e. right after mount,
        // before init resolves — used to throw "Renderer not initialized"
        // from `beginPointCloudStream`. Wait for the device to be ready.
        await renderer.whenReady();
        setProgress({ phase: `Streaming ${format.toUpperCase()}`, percent: 5 });
        setGeometryStreamingActive(false);
        const blob = file;
        const incCount = useViewerStore.getState().incrementPointCloudAssetCount;
        const ingest = ingestPointCloud({
          format,
          blob,
          fileName: file.name,
          fileSize: file.size,
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
        posthog.capture('ifc_model_loaded', { format, file_size_mb: Math.round(fileSizeMB * 100) / 100, load_target: target.kind, load_path: 'point-cloud', total_elapsed_ms: Math.round(performance.now() - totalStartTime) });
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
          posthog.capture('ifc_model_loaded', { format: 'ifcx', file_size_mb: Math.round(fileSizeMB * 100) / 100, load_target: target.kind, load_path: 'wasm', total_elapsed_ms: Math.round(performance.now() - totalStartTime) });
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
          posthog.capture('ifc_model_loaded', { format: 'glb', file_size_mb: Math.round(fileSizeMB * 100) / 100, load_target: target.kind, load_path: 'wasm', total_elapsed_ms: Math.round(performance.now() - totalStartTime) });
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

      // Cache key = size + spread-sampled content fingerprint + format version.
      // The fingerprint (`sourceFingerprint.ts`) hashes a ~160KB spread (head +
      // tail + interior windows) plus the exact byte length, so a key match is
      // itself the validation — a genuinely different file can't key the same
      // entry. `.hash` is reused as the cache header's `sourceHash` so the write
      // path never pays a full-file hash either.
      const fingerprint = computeSourceFingerprint(buffer);
      // Snapshot the merge-layers flag *before* the cache lookup: it is a
      // load-time WASM tessellation input (issue #540) and must discriminate
      // the cache key, otherwise toggling it + reloading serves geometry built
      // with the previous flag (issue #1107). Reused below for the
      // GeometryProcessor so the key and the actual tessellation agree.
      const mergeLayersAtLoad = useViewerStore.getState().mergeLayers;
      // Snapshot the geometry-fidelity mode the same way: it is a load-time
      // tessellation input, so it must discriminate the cache key and be reused
      // for the GeometryProcessor. `fast` = skip sub-10% cuts + auto-low density
      // for heavy models; `exact` = full cuts + full density.
      const geometryModeAtLoad = useViewerStore.getState().geometryMode;
      const skipSmallCutsAtLoad = geometryModeAtLoad === 'fast';
      // Tessellation tier from the mode: a `?geomTier=` override wins, else
      // auto-low for heavy models by file size in `fast` mode only (the only
      // model-weight signal available pre-geometry, so the key stays
      // deterministic at cache-check time). `undefined` = engine default
      // (medium). `exact` never auto-lowers.
      const loadTessellationTier = resolveLoadTessellationTier(fileSizeMB, geometryModeAtLoad);
      // Desktop Tauri cache commands only accept [A-Za-z0-9_-], so the key
      // stays filename-safe and independent of the original filename. Pinned
      // to FORMAT_VERSION so a format bump invalidates stale entries (e.g. v5
      // added the geometryClass tag the Model/Types switch needs).
      const cacheKey = buildGeometryCacheKey(
        buffer.byteLength,
        fingerprint.hex,
        mergeLayersAtLoad,
        undefined,
        skipSmallCutsAtLoad,
        loadTessellationTier
      );
      console.log(`[useIfc] loadFile "${file.name}" session=${currentSession} mergeLayers=${mergeLayersAtLoad} geomMode=${geometryModeAtLoad} tier=${loadTessellationTier ?? 'medium'} cacheKey=${cacheKey}`);

      // Decide the cache tier ONCE (single source of truth for read + write, see
      // cacheTier.ts): the source tier (<=150MB) always caches; the mesh-only
      // tier (150-400MB) caches only while enabled (kill switch `?meshCache=0`);
      // nothing else caches. Gating the READ on `shouldCache` too makes the kill
      // switch complete — with it off, a previously written mesh-only entry is
      // NOT served (and files outside any band skip a pointless lookup).
      const cachePlan = planCacheWrite(buffer.byteLength, {
        meshOnlyEnabled: isMeshOnlyCacheEnabled(),
        minSize: CACHE_SIZE_THRESHOLD,
        maxSourceSize: CACHE_MAX_SOURCE_SIZE,
        maxMeshOnlySize: CACHE_MESH_ONLY_MAX_SIZE,
      });

      // Cache + server are PRIMARY-ONLY: a federated add is WASM-only with no
      // cache/server round-trip (matches the former parseStepBufferViewerModel).
      if (target.kind === 'primary' && cachePlan.shouldCache) {
        setProgress({ phase: 'Checking cache', percent: 5 });
        const cacheResult = await getCached(cacheKey);
        if (cacheResult) {
          // A source-decoupled (mesh-only) entry persisted NO source, so it will
          // hydrate cached geometry against the FRESH buffer — validate the source
          // before serving. The O(1) spread key can't see a byte-length-preserving
          // in-place edit that falls between its sample windows, so the mtime guard
          // is the real gate: a changed on-disk mtime → MISS (reparse); an
          // unvalidatable hit (no mtime AND no full hash) → MISS. The classic
          // source-persisting tier serves cached geometry + cached source together
          // (self-consistent), so it skips this entirely.
          const isSourceDecoupled = !cacheResult.sourceBuffer;
          const mayServe = !isSourceDecoupled || decideMeshOnlyCacheHit({
            storedMtime: cacheResult.lastModified,
            freshMtime: file.lastModified,
            hasFullHash: !!cacheResult.fullSourceHash,
          }) === 'serve';

          if (!mayServe) {
            console.warn(`[useIfc] source-decoupled cache MISS (source changed / unvalidatable) — reparsing "${file.name}"`);
            await deleteCached(cacheKey);
          } else {
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
              posthog.capture('ifc_model_loaded', { format, file_size_mb: Math.round(fileSizeMB * 100) / 100, load_target: target.kind, load_path: 'cache', total_elapsed_ms: Math.round(performance.now() - totalStartTime) });
              // Steady-state draw-call/GPU telemetry — same reporter as the
              // fresh path so warm (cache) loads are comparable (issue #1682).
              void reportRenderStats({
                fileName: file.name,
                fileSizeMB,
                isStale: () => loadSessionRef.current !== currentSession,
              });
              setLoading(false);
              // Belt-and-suspenders for the source-decoupled tier: revalidate the
              // TRUE full-file hash off the main thread and, if the source changed
              // with its mtime preserved, purge + auto-reload. Fire-and-forget so
              // the instant hit above is never delayed.
              if (isSourceDecoupled && cacheResult.fullSourceHash) {
                void revalidateSourceDecoupledHit({
                  file,
                  target,
                  buffer,
                  cacheKey,
                  expectedHash: cacheResult.fullSourceHash,
                  session: currentSession,
                });
              }
              return;
            }
          }
        }
      }

      // Try server parsing first (enabled by default for multi-core performance)
      // Only for IFC4 STEP files (server doesn't support IFCX). Native
      // file handles (Tauri) don't have an HTTP-uploadable body, so skip
      // the server path and fall through to the WASM loader.
      // Skip it when merge-layers is on: the server tessellates without that
      // flag and its cache key ignores it, so a toggle+reload would still return
      // non-merged geometry (issue #1107). Merge-layers is opt-in, so the common
      // load keeps the server fast path.
      //
      // The geometry-fidelity mode (skip-small-cuts / auto-low tier) is a
      // LOCAL-WASM display optimization and does NOT gate the server here. The
      // server produces canonical full-fidelity geometry and caches it under its
      // OWN key (useIfcServer: streamResult.cache_key) — it never writes the
      // local `-sc/-tlow` cacheKey, so there is no key/geometry mismatch. Gating
      // the server on the default-on `fast` mode would disable the multi-core
      // server fast-path for every primary IFC load (the cause of an "overall
      // slower" regression on server-enabled deploys); fast mode still applies on
      // every local-path load (IFCX, merge-layers, Tauri, or server-off).
      // A .ifcZIP source is fine on the server path: loadFromServer uploads the
      // original `file` object (still zipped) and the server unwraps the
      // container itself (apps/server extract_file, issue #1494) before parsing.
      if (target.kind === 'primary' && format === 'ifc' && !mergeLayersAtLoad && USE_SERVER && SERVER_URL && SERVER_URL !== '') {
        // Pass buffer directly - server uses File object for parsing, buffer is only for size checks
        const serverSuccess = await loadFromServer(file, buffer, () => loadSessionRef.current !== currentSession);
        if (serverSuccess) {
          const state = useViewerStore.getState();
          await finalizeModel(state.ifcDataStore, state.geometryResult, getSchemaVersion(state.ifcDataStore));
          console.log(`[useIfc] TOTAL LOAD TIME (server): ${(performance.now() - totalStartTime).toFixed(0)}ms`);
          posthog.capture('ifc_model_loaded', { format, file_size_mb: Math.round(fileSizeMB * 100) / 100, load_target: target.kind, load_path: 'server', total_elapsed_ms: Math.round(performance.now() - totalStartTime) });
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
      // Reuses the merge-layers snapshot taken above for the cache key so the
      // key and the WASM tessellation always agree (issues #540, #1107).
      const geometryProcessor = new GeometryProcessor({
        quality: GeometryQuality.Balanced,
        // Auto-low vertex density for heavy models (or `?geomTier=` override);
        // `undefined` keeps the engine default (medium, full-density curves).
        // Must match the tier folded into `cacheKey` above so the cached bytes
        // and the live tessellation agree (issues #540, #1107).
        tessellationQuality: loadTessellationTier,
        // Skip tiny detail boolean cuts in `fast` mode for quick first paint
        // (#1286); `exact` mode keeps every cut. Must match the flag folded into
        // `cacheKey` above so cached bytes and live tessellation agree (#540, #1107).
        skipSmallCuts: skipSmallCutsAtLoad,
        preferNative: false,
        // Issue #540: snapshot at load time so the WASM bridge applies
        // the flag before the first parseMeshes* call.
        mergeLayers: mergeLayersAtLoad,
        // GPU instancing is primary-model only (single global scene, primary id
        // space). A federated load must keep all geometry flat, else its opaque
        // repeated occurrences would be partitioned into shards the federated path
        // doesn't consume and silently dropped.
        enableInstancing: target.kind === 'primary',
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
      const allInstancedShards: ArrayBuffer[] = []; // Raw IFNS shard bytes, retained for the cache write
      // #924 compare parity: geometry-diff hashes for instanced-ONLY entities
      // (their meshes never enter `allMeshes`). Folded onto the GeometryResult so
      // buildEntityFingerprints can still diff repeated opaque geometry.
      const allInstancedGeometryHashes = new Map<number, bigint>();
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
              // `?geomWorkers=N` A/B knob — overrides the cores/memory worker-
              // count heuristic so the host's thermal sweet spot can be measured.
              // Still clamped to the memory budget by the engine. Geometry output
              // is unaffected by the count (disjoint deterministic element slices).
              workerCountOverride: getGeomWorkerOverride(),
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
                // Do NOT embed `file.name` here — this Error is captured by
                // error tracking (and auto-filed as a public GitHub issue), so
                // a confidential model name would leak. The file name is added
                // back for the user only, via formatLoadError(err, file.name).
                reject(new Error(
                  `Geometry stream stalled after ${watchdogMs}ms. ` +
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
              // #924: fold instanced-only entity geometry hashes (no flat mesh
              // carries them) into the model map so compare can diff them.
              if (event.instancedGeometryHashIds && event.instancedGeometryHashValues) {
                const hashIds = event.instancedGeometryHashIds;
                const hashVals = event.instancedGeometryHashValues;
                const hashN = Math.min(hashIds.length, hashVals.length);
                for (let i = 0; i < hashN; i++) {
                  allInstancedGeometryHashes.set(hashIds[i], hashVals[i]);
                }
              }
              finalCoordinateInfo = event.coordinateInfo ?? null;
              totalMeshes = event.totalSoFar;
              lastTotalMeshes = event.totalSoFar;

              if (target.kind === 'primary') {
                // GPU-instancing: hand the batch's IFNS shards to the store so
                // useGeometryStreaming decodes + uploads them via the instanced path.
                // Also retain the raw bytes so they're written into the cache (the
                // decode/upload only reads them, never detaches) — otherwise a cache
                // reload would drop every instanced occurrence. Empty for non-
                // instanced models / older wasm.
                if (event.instancedShards && event.instancedShards.length > 0) {
                  appendInstancedShards(event.instancedShards);
                  for (let i = 0; i < event.instancedShards.length; i++) {
                    allInstancedShards.push(event.instancedShards[i]);
                  }
                }
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

              // Geometry diagnostics (the typed GeometryDiagnostics contract on the
              // streaming `complete` event). Surface a concise main-thread summary
              // when CSG failures or silent no-ops were recorded (for the primary
              // model and each federated add — file.name disambiguates); the full
              // object stays on `event.diagnostics` for any UI/telemetry consumer.
              if (event.diagnostics) {
                const d = event.diagnostics;
                if (d.totalCsgFailures > 0 || d.silentNoOps > 0) {
                  console.info(
                    `[useIfc] ${file.name} geometry diagnostics: ${d.totalCsgFailures} CSG failure(s) ` +
                      `across ${d.productsWithFailures} product(s), ${d.silentNoOps} silent no-op(s)`,
                    d,
                  );
                }
              }

              if (target.kind === 'primary') {
                // Active-model writes — PRIMARY only. Federated meshes already
                // carry colours (applied during streaming) and their coordinate
                // info rides the geometryResult handed to addModel at finalize.
                if (cumulativeColorUpdates.size > 0) {
                  updateMeshColors(cumulativeColorUpdates);
                }
                updateCoordinateInfo(finalCoordinateInfo);
                // #924 compare parity: the streamed geometryResult holds flat
                // meshes only, so fold the instanced-only entity hashes onto it
                // before finalize reads it (no-op when hashing is off / nothing
                // was fully instanced).
                if (allInstancedGeometryHashes.size > 0) {
                  const gr = useViewerStore.getState().geometryResult;
                  if (gr) {
                    setGeometryResult({ ...gr, instancedGeometryHashes: allInstancedGeometryHashes });
                  }
                }
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
                if (loadSessionRef.current !== currentSession) {
                  console.warn(`[useIfc] finalize ABORTED: stale session (mine=${currentSession}, current=${loadSessionRef.current}) — model will blank`);
                  return;
                }
                console.log(`[useIfc] finalizing: session=${currentSession} meshes=${useViewerStore.getState().geometryResult?.meshes?.length ?? 0} dataStore=${!!dataStore}`);

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
                    // Empty for federated (instancing is primary-only) but kept for
                    // shape consistency / future-proofing. (#924 compare parity)
                    ...(allInstancedGeometryHashes.size > 0
                      ? { instancedGeometryHashes: allInstancedGeometryHashes }
                      : {}),
                  };
                  await finalizeModel(dataStore, federatedGeometry, getSchemaVersion(dataStore), {
                    loadState: 'complete',
                  });
                  return;
                }

                await finalizeModel(dataStore, useViewerStore.getState().geometryResult, getSchemaVersion(dataStore), {
                  loadState: 'complete',
                  // Only show "writing" when this file will actually be cached
                  // under the current plan (respects the size bands + kill switch).
                  cacheState: cachePlan.shouldCache ? 'writing' : 'none',
                });
                // Build spatial index from meshes in time-sliced chunks (non-blocking).
                // Previously this was synchronous inside requestIdleCallback, blocking
                // the main thread for seconds on 200K+ mesh models (190M+ float reads
                // for bounds computation alone).
                buildSpatialIndexGuarded(allMeshes, dataStore, setIfcDataStore);

                // Cache the result in the background, reusing the `cachePlan`
                // decided once above (single source of truth for read + write).
                // The two tiers differ ONLY in `persistSource` and the size band:
                //  - `source` (10-150MB): persist tables + geometry AND the source
                //    buffer, so lazy property/quantity accessors + IFC re-export read
                //    it straight from IndexedDB.
                //  - `mesh-only` (150-400MB, on by default; kill switch `?meshCache=0`):
                //    the source is too big to persist, so cache tables + geometry
                //    WITHOUT it; on re-open the freshly read buffer rehydrates the
                //    accessors. The hit is validated by the strengthened cache key,
                //    so repeat opens have no main-thread hash stall.
                // Files above 400MB (or with the mesh-only kill switch set) are not cached.
                if (
                  cachePlan.shouldCache &&
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
                    // Persist the GPU-instancing shards too, else a cache reload would
                    // restore the flat meshes only and drop all instanced occurrences.
                    ...(allInstancedShards.length > 0 ? { instancedShards: allInstancedShards } : {}),
                  };
                  await saveToCache(cacheKey, dataStore, geometryData, buffer, file.name, {
                    persistSource: cachePlan.persistSource,
                    // mtime guard for a source-decoupled hit (the full-file
                    // validation hash is computed off-thread inside saveToCache).
                    lastModified: file.lastModified,
                  });
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
                if (target.kind === 'federated') {
                  // No placeholder model exists for a federated add (it is only
                  // registered on success via finalizeModel→addModel), so
                  // updateModel would no-op and the failure would vanish —
                  // addModel just returns null. Surface it to the user instead.
                  toast.error(formatLoadError(err, file.name));
                } else {
                  updateModel(modelId, {
                    loadState: 'error',
                    loadError: formatLoadError(err, file.name),
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
        // A WASM engine-load failure (e.g. the geometry binary 404'd) surfaces
        // here as a cryptic `compile on 'WebAssembly'` TypeError — humanise it
        // and tag the captured exception so it is filterable in error tracking.
        const kind = classifyLoadError(err);
        setError(formatLoadError(err, file.name));
        posthog.captureException(err, {
          additional_properties: { context: 'geometry_processing', error_kind: kind },
        });
        setLoading(false);
        setGeometryStreamingActive(false);
        return;
      }

      if (loadSessionRef.current !== currentSession) {
        console.warn(`[useIfc] post-stream ABORTED: stale session (mine=${currentSession}, current=${loadSessionRef.current})`);
        return;
      }

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
      posthog.capture('ifc_model_loaded', {
        format,
        file_size_mb: Math.round(fileSizeMB * 100) / 100,
        load_target: target.kind,
        load_path: 'wasm',
        mesh_count: allMeshes.length,
        total_elapsed_ms: Math.round(totalElapsedMs),
        // Field perf telemetry: vertices/triangles size the model, and the
        // milestones (read → metadata → first batch → first paint → stream
        // done) let us spot where real-world loads regress. CSG itself runs
        // in the geometry workers, so the stream window is its best proxy.
        total_vertices: totalVertices,
        total_triangles: allMeshes.reduce((sum, m) => sum + m.indices.length / 3, 0),
        file_read_ms: Math.round(fileReadMs),
        metadata_complete_ms: metadataCompleteMs != null ? Math.round(metadataCompleteMs) : undefined,
        first_geometry_batch_ms: firstAppendGeometryBatchMs != null ? Math.round(firstAppendGeometryBatchMs) : undefined,
        first_visible_geometry_ms: firstVisibleGeometryMs != null ? Math.round(firstVisibleGeometryMs) : undefined,
        stream_complete_ms: streamCompleteMs != null ? Math.round(streamCompleteMs) : undefined,
      });
      // Steady-state draw-call/GPU-memory telemetry (issue #1682) — fired
      // separately from ifc_model_loaded because it must wait for the scene
      // to settle (queue drain + fragment finalize), which happens after this
      // summary on large models. Fire-and-forget by design; the stale guard
      // hands off to the newer load's reporter when a load supersedes this one.
      void reportRenderStats({
        fileName: file.name,
        fileSizeMB,
        isStale: () => loadSessionRef.current !== currentSession,
      });
      setLoading(false);
      setGeometryStreamingActive(false);
      // Normalize progress to a terminal state, mirroring the loading /
      // streaming flags reset above. A federated georef model runs
      // finalizeModel AFTER the streaming 'Complete' 100% and re-sets progress
      // to 'Aligning georeferenced model' 90%; without this reset it sticks
      // below 100%, and getPickOptions() then reports isStreaming=true forever,
      // disabling ALL element picking once a second model is loaded (#1570).
      setProgress({ phase: 'Complete', percent: 100 });
    } catch (err) {
      console.error(`[useIfc] loadFile THREW (session=${currentSession}, current=${loadSessionRef.current}):`, err);
      if (loadSessionRef.current !== currentSession) return;
      const kind = classifyLoadError(err);
      const friendly = formatLoadError(err, file.name);
      updateModel(modelId, {
        loadState: 'error',
        loadError: friendly,
      });
      setError(friendly);
      posthog.captureException(err, {
        additional_properties: { context: 'ifc_model_load', error_kind: kind },
      });
      setLoading(false);
      setGeometryStreamingActive(false);
    }
  }, [setLoading, setGeometryStreamingActive, setError, setProgress, setIfcDataStore, setGeometryResult, appendGeometryBatch, appendInstancedShards, updateMeshColors, updateCoordinateInfo, loadFromCache, saveToCache, loadFromServer, revalidateSourceDecoupledHit]);

  // Keep the ref pointed at the latest loadFile so a background revalidation can
  // trigger a reparse-reload without loadFile depending on itself.
  useEffect(() => {
    loadFileRef.current = loadFile;
  }, [loadFile]);

  return { loadFile };
}

export default useIfcLoader;
