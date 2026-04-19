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
import { getViewerStoreApi, useViewerStore } from '@/store';
import { IfcParser, detectFormat, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, GeometryQuality, type MeshData, type CoordinateInfo } from '@ifc-lite/geometry';
import initIfcLiteWasm, { IfcAPI } from '@ifc-lite/wasm';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import { type GeometryData } from '@ifc-lite/cache';

import { SERVER_URL, USE_SERVER, CACHE_SIZE_THRESHOLD, CACHE_MAX_SOURCE_SIZE, HUGE_NATIVE_FILE_THRESHOLD, getDynamicBatchConfig } from '../utils/ifcConfig.js';
import {
  calculateMeshBounds,
  createCoordinateInfo,
  getRenderIntervalMs,
  calculateStoreyHeights,
} from '../utils/localParsingUtils.js';
import { buildDesktopMetadataSnapshot, restoreDesktopMetadataSnapshot } from '../utils/desktopModelSnapshot.js';
import { buildIfcDataStoreFromNativeMetadata } from '../utils/nativeSpatialDataStore.js';
import { applyColorUpdatesToMeshes } from './meshColorUpdates.js';
import { readNativeFile, type NativeFileHandle } from '../services/file-dialog.js';
import {
  bootstrapNativeMetadata,
  persistNativeMetadataSnapshot,
  restoreNativeMetadataSnapshot,
} from '../services/desktop-native-metadata.js';
import { finalizeActiveHarnessRun, getActiveHarnessRequest } from '../services/desktop-harness.js';
import { logToDesktopTerminal } from '../services/desktop-logger.js';

// Cache hook
import { useIfcCache, getCached } from './useIfcCache.js';

// Server hook
import { useIfcServer } from './useIfcServer.js';

import { getMaxExpressId, parseGlbViewerModel, parseIfcxViewerModel } from './ingest/viewerModelIngest.js';

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

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function yieldToUiThread(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function getGeometryStreamWatchdogMs(
  desktopStableWasm: boolean,
  batchCount: number,
): number {
  if (desktopStableWasm) {
    return batchCount > 0 ? 5_000 : 15_000;
  }
  return batchCount > 0 ? 15_000 : 30_000;
}

function countNativeSpatialNodes(
  node: { children?: Array<{ children?: unknown[] }> } | null | undefined,
): number {
  if (!node) return 0;
  const children = Array.isArray(node.children) ? node.children : [];
  let total = 1;
  for (let i = 0; i < children.length; i += 1) {
    total += countNativeSpatialNodes(children[i] as { children?: Array<{ children?: unknown[] }> });
  }
  return total;
}

function computeNativeCacheKey(file: NativeFileHandle): string {
  const encodedPath = new TextEncoder().encode(file.path);
  const pathHash = computeFastFingerprint(toExactArrayBuffer(encodedPath));
  return `native-ifc-${file.size}-${file.modifiedMs ?? 0}-${pathHash}-v1`;
}

function isNativeFileHandle(file: File | NativeFileHandle): file is NativeFileHandle {
  return typeof (file as NativeFileHandle).path === 'string';
}

let metadataScanApiPromise: Promise<IfcAPI> | null = null;

async function getMetadataScanApi(): Promise<IfcAPI> {
  if (!metadataScanApiPromise) {
    metadataScanApiPromise = (async () => {
      await initIfcLiteWasm();
      return new IfcAPI();
    })();
  }
  return metadataScanApiPromise;
}

const ENABLE_HUGE_TIME_FLUSH = import.meta.env.VITE_IFC_ENABLE_HUGE_TIME_FLUSH === 'true';

async function* startDisabledNativeDesktopRendererModel(
  _path: string,
  _cacheKey?: string,
): AsyncGenerator<any, void, unknown> {
  throw new Error('Native desktop renderer is disabled');
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

  const loadFile = useCallback(async (file: File | NativeFileHandle) => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();
    const currentSession = ++loadSessionRef.current;
    const primaryModelId = crypto.randomUUID();

    // Track total elapsed time for complete user experience
    const totalStartTime = performance.now();

    try {
      // Reset all viewer state before loading new file
      // Also clear models Map to ensure clean single-file state
      resetViewerState();
      clearAllModels();

      setLoading(true);
      setGeometryStreamingActive(false);
      setError(null);
      setBoundedGeometryMode(false);
      setGeometryProgress(null);
      setMetadataProgress(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      const fileName = file.name;
      const fileSize = file.size;
      const fileSizeMB = fileSize / (1024 * 1024);

      upsertModel({
        id: primaryModelId,
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
          nativeMetadata: null,
        cacheState: 'none',
        loadError: null,
      });
      updateModel(primaryModelId, {
        loadState: 'streaming-geometry',
        geometryLoadState: 'opening',
        metadataLoadState: 'idle',
        interactiveReady: false,
      });

      const finalizePrimaryModel = (
        dataStore: IfcDataStore | null,
        geometryResult: { meshes: MeshData[]; totalVertices: number; totalTriangles: number; coordinateInfo: CoordinateInfo } | null,
        schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5',
        patch?: { loadState?: 'pending' | 'streaming-geometry' | 'hydrating-metadata' | 'complete' | 'error'; cacheState?: 'none' | 'hit' | 'miss' | 'writing'; loadError?: string | null },
      ) => {
        let idOffset = 0;
        let maxExpressId = 0;
        if (dataStore && geometryResult) {
          maxExpressId = getMaxExpressId(dataStore, geometryResult.meshes);
          idOffset = registerModelOffset(primaryModelId, maxExpressId);
        }

        updateModel(primaryModelId, {
          ifcDataStore: dataStore,
          geometryResult,
          schemaVersion,
          idOffset,
          maxExpressId,
          loadState: patch?.loadState ?? 'complete',
          cacheState: patch?.cacheState ?? 'none',
          loadError: patch?.loadError ?? null,
        });
      };
      const getSchemaVersion = (dataStore: IfcDataStore | null): 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5' => {
        if (!dataStore) return 'IFC4';
        if (dataStore.schemaVersion === 'IFC4X3') return 'IFC4X3';
        if (dataStore.schemaVersion === 'IFC4') return 'IFC4';
        if (dataStore.schemaVersion === 'IFC5') return 'IFC5';
        return 'IFC2X3';
      };

      if (
        isNativeFileHandle(file) &&
        fileName.toLowerCase().endsWith('.ifc') &&
        false
      ) {
        const harnessRequest = getActiveHarnessRequest();
        const nativeCacheKey = computeNativeCacheKey(file);
        const shouldUseNativeCache = file.size >= CACHE_SIZE_THRESHOLD;
        const hugeNativeMode = file.size >= HUGE_NATIVE_FILE_THRESHOLD;
        let firstBatchWaitMs: number | null = null;
        let firstVisibleGeometryMs: number | null = null;
        let modelOpenMs: number | null = null;
        let streamCompleteMs: number | null = null;
        let batchCount = 0;
        let totalMeshes = 0;
        let spatialReadyMs: number | null = null;
        let metadataStartMs: number | null = null;
        let metadataReadCompleteMs: number | null = null;
        let metadataParseStartMs: number | null = null;
        let metadataCompleteMs: number | null = null;
        let metadataFailedMs: number | null = null;
        let metadataReadDurationMs: number | null = null;
        let metadataBufferCopyDurationMs: number | null = null;
        let metadataParseDurationMs: number | null = null;
        let metadataSnapshotWritePromise: Promise<void> | null = null;
        let metadataParsingPromise: Promise<void> | null = null;
        let metadataParsingStarted = false;
        let geometryCompleted = false;
        let nativeGeometryCacheHit = false;
        let nativeMetadataSnapshotHit = false;
        let nativeMetadataSource: 'snapshot' | 'ifc-parse' = 'ifc-parse';
        let nativeMetadataStartGate: 'immediate' | 'afterInteractiveGeometry' | 'afterGeometryComplete' = 'immediate';
        let finalCoordinateInfo: CoordinateInfo | null = null;

        console.log(`[useIfc] Native renderer load: ${fileName}, size: ${fileSizeMB.toFixed(2)}MB`);
        void logToDesktopTerminal(
          'info',
          `[useIfc] Native renderer load start: ${fileName} (${fileSizeMB.toFixed(2)} MB) path=${file.path}`
        );

        setBoundedGeometryMode(true);
        setGeometryResult(null);
        setIfcDataStore(null);
        setProgress({ phase: 'Starting native renderer', percent: 10 });

        const queueNativeMetadataSnapshotWrite = (
          dataStore: IfcDataStore,
          sourceBuffer: ArrayBuffer,
        ) => {
          metadataSnapshotWritePromise = (async () => {
            await yieldToUiThread();
            if (typeof requestAnimationFrame === 'function') {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            if (!shouldUseNativeCache) return;
            try {
              const { setNativeModelSnapshot } = await import('../services/desktop-cache.js');
              const snapshotBuffer = await buildDesktopMetadataSnapshot(dataStore, sourceBuffer);
              await setNativeModelSnapshot(nativeCacheKey, snapshotBuffer);
            } catch (error) {
              void logToDesktopTerminal(
                'warn',
                `[useIfc] Native metadata snapshot write failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })();
        };

        const finalizeNativeMetadata = (dataStore: IfcDataStore) => {
          if (dataStore.spatialHierarchy && dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
            const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
            for (const [storeyId, height] of calculatedHeights) {
              dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
            }
          }
          setIfcDataStore(dataStore);
          finalizePrimaryModel(
            dataStore,
            null,
            getSchemaVersion(dataStore),
            {
              loadState: geometryCompleted ? 'complete' : 'hydrating-metadata',
              cacheState: nativeGeometryCacheHit ? 'hit' : shouldUseNativeCache ? 'writing' : 'none',
            },
          );
        };

        const startNativeMetadataParsing = (): Promise<void> | null => {
          if (metadataParsingStarted) return metadataParsingPromise;
          metadataParsingStarted = true;
          metadataStartMs = performance.now() - totalStartTime;
          updateModel(primaryModelId, { loadState: 'hydrating-metadata' });
          void logToDesktopTerminal(
            'info',
            `[useIfc] Native metadata parse start for ${fileName} source=${nativeMetadataSource} gate=${nativeMetadataStartGate}`
          );

          metadataParsingPromise = (async () => {
            const metadataReadStart = performance.now();
            let parseStart = 0;

            if (nativeMetadataSnapshotHit) {
              try {
                const { getNativeModelSnapshot } = await import('../services/desktop-cache.js');
                const snapshotBuffer = await getNativeModelSnapshot(nativeCacheKey);
                if (snapshotBuffer) {
                  metadataReadCompleteMs = performance.now() - totalStartTime;
                  metadataReadDurationMs = performance.now() - metadataReadStart;
                  metadataParseStartMs = performance.now() - totalStartTime;
                  parseStart = performance.now();
                  const dataStore = await restoreDesktopMetadataSnapshot(snapshotBuffer);
                  if (spatialReadyMs === null) {
                    spatialReadyMs = performance.now() - totalStartTime;
                  }
                  metadataCompleteMs = performance.now() - totalStartTime;
                  metadataParseDurationMs = performance.now() - parseStart;
                  finalizeNativeMetadata(dataStore);
                  return;
                }
              } catch (error) {
                nativeMetadataSnapshotHit = false;
                nativeMetadataSource = 'ifc-parse';
                void logToDesktopTerminal(
                  'warn',
                  `[useIfc] Native metadata snapshot hydration failed for ${fileName}, falling back to IFC parse: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }

            const bytes = await readNativeFile(file.path);
            if (loadSessionRef.current !== currentSession) return;
            metadataReadCompleteMs = performance.now() - totalStartTime;
            metadataReadDurationMs = performance.now() - metadataReadStart;
            const copyStart = performance.now();
            const metadataBuffer = toExactArrayBuffer(bytes);
            metadataBufferCopyDurationMs = performance.now() - copyStart;
            metadataParseStartMs = performance.now() - totalStartTime;
            parseStart = performance.now();
            const parser = new IfcParser();
            const wasmApi = hugeNativeMode ? await getMetadataScanApi() : undefined;
            const dataStore = await parser.parseColumnar(metadataBuffer, {
              wasmApi,
              yieldIntervalMs: hugeNativeMode ? 32 : undefined,
              deferPropertyAtomIndex: hugeNativeMode,
              disableWorkerScan: false,
              onSpatialReady: (partialStore) => {
                if (loadSessionRef.current !== currentSession) return;
                if (spatialReadyMs === null) {
                  spatialReadyMs = performance.now() - totalStartTime;
                }
                setIfcDataStore(partialStore);
              },
            });
            queueNativeMetadataSnapshotWrite(dataStore, metadataBuffer);
            metadataCompleteMs = performance.now() - totalStartTime;
            metadataParseDurationMs = performance.now() - parseStart;
            finalizeNativeMetadata(dataStore);
          })().catch((error) => {
            if (loadSessionRef.current !== currentSession) return;
            metadataFailedMs = performance.now() - totalStartTime;
            updateModel(primaryModelId, {
              loadState: 'error',
              loadError: error instanceof Error ? error.message : String(error),
            });
            void logToDesktopTerminal(
              'warn',
              `[useIfc] Native metadata parse failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`
            );
          });

          return metadataParsingPromise;
        };

        if (shouldUseNativeCache) {
          const { hasNativeGeometryCache, hasNativeModelSnapshot } = await import('../services/desktop-cache.js');
          setProgress({ phase: 'Checking native cache', percent: 5 });
          nativeGeometryCacheHit = await hasNativeGeometryCache(nativeCacheKey);
          nativeMetadataSnapshotHit = nativeGeometryCacheHit ? await hasNativeModelSnapshot(nativeCacheKey) : false;
          nativeMetadataSource = nativeGeometryCacheHit && nativeMetadataSnapshotHit ? 'snapshot' : 'ifc-parse';
          nativeMetadataStartGate = 'immediate';
          updateModel(primaryModelId, { cacheState: nativeGeometryCacheHit ? 'hit' : 'miss' });
        }

        if (nativeMetadataStartGate === 'immediate') {
          startNativeMetadataParsing();
        } else {
          void logToDesktopTerminal(
            'info',
            `[useIfc] Deferring native metadata to ${nativeMetadataStartGate} for ${fileName}`
          );
        }

        const nativeStream = await startDisabledNativeDesktopRendererModel(
          file.path,
          shouldUseNativeCache ? nativeCacheKey : undefined,
        );

        for await (const event of nativeStream) {
          switch (event.type) {
            case 'sessionReady':
              void logToDesktopTerminal(
                'info',
                event.cacheHit
                  ? `[useIfc] Native renderer cache hit for ${fileName}`
                  : `[useIfc] Native renderer cold load for ${fileName}`
              );
              break;
            case 'modelOpen':
              modelOpenMs = performance.now() - totalStartTime;
              setProgress({ phase: 'Streaming geometry into native renderer', percent: 35 });
              break;
            case 'batch':
              batchCount = event.batchCount;
              totalMeshes = event.totalMeshes;
              if (firstBatchWaitMs === null) {
                firstBatchWaitMs = performance.now() - totalStartTime;
              }
              setProgress({
                phase: `Uploading native geometry (${(event.totalMeshes ?? 0).toLocaleString()} meshes)`,
                percent: Math.min(85, 35 + Math.log10(Math.max(10, event.totalMeshes ?? 0)) * 12),
              });
              break;
            case 'firstFrame':
              firstVisibleGeometryMs = performance.now() - totalStartTime;
              if (nativeMetadataStartGate === 'afterInteractiveGeometry' && !metadataParsingStarted) {
                startNativeMetadataParsing();
              }
              break;
            case 'complete':
              geometryCompleted = true;
              streamCompleteMs = performance.now() - totalStartTime;
              totalMeshes = event.totalMeshes;
              finalCoordinateInfo = event.coordinateInfo;
              updateCoordinateInfo(event.coordinateInfo);
              if (nativeMetadataStartGate === 'afterGeometryComplete' && !metadataParsingStarted) {
                startNativeMetadataParsing();
              }
              updateModel(primaryModelId, {
                loadState: metadataParsingStarted ? 'hydrating-metadata' : 'complete',
                cacheState: nativeGeometryCacheHit ? 'hit' : shouldUseNativeCache ? 'writing' : 'none',
              });
              setProgress({
                phase: metadataParsingStarted ? 'Geometry ready, hydrating metadata' : 'Native geometry ready',
                percent: metadataParsingStarted ? 92 : 100,
              });
              break;
            case 'error':
              throw new Error(event.message);
          }
        }

        if (harnessRequest?.waitForMetadataCompletion) {
          if (!metadataParsingStarted) {
            startNativeMetadataParsing();
          }
          if (metadataParsingPromise) {
            await metadataParsingPromise;
          }
          if (metadataSnapshotWritePromise) {
            await metadataSnapshotWritePromise;
          }
        }

        if (firstVisibleGeometryMs === null && streamCompleteMs !== null) {
          firstVisibleGeometryMs = streamCompleteMs;
        }

        if (!metadataParsingStarted) {
          setLoading(false);
        } else if (!harnessRequest?.waitForMetadataCompletion) {
          setLoading(false);
        }

        await finalizeActiveHarnessRun({
          schemaVersion: 1,
          source: 'desktop-native',
          mode: harnessRequest ? 'startup-harness' : 'manual',
          success: true,
          runLabel: harnessRequest?.runLabel,
          cache: {
            key: nativeCacheKey,
            hit: nativeGeometryCacheHit,
            manifestMeshCount: null,
            manifestShardCount: null,
          },
          file: {
            path: file.path,
            name: file.name,
            sizeBytes: file.size,
            sizeMB: fileSizeMB,
          },
          timings: {
            modelOpenMs,
            firstBatchWaitMs,
            firstAppendGeometryBatchMs: null,
            firstVisibleGeometryMs,
            streamCompleteMs,
            totalWallClockMs: performance.now() - totalStartTime,
            metadataStartMs,
            metadataReadCompleteMs,
            metadataParseStartMs,
            spatialReadyMs,
            metadataCompleteMs,
            metadataFailedMs,
            metadataReadDurationMs,
            metadataBufferCopyDurationMs,
            metadataParseDurationMs,
            nativeRendererFirstFrameMs: firstVisibleGeometryMs,
          },
          batches: {
            estimatedTotal: shouldUseNativeCache ? totalMeshes : null,
            totalBatches: batchCount,
            totalMeshes,
            firstBatchMeshes: null,
            firstPayloadKind: 'native-renderer',
          },
          nativeStats: finalCoordinateInfo
            ? {
                parseTimeMs: null,
                entityScanTimeMs: null,
                lookupTimeMs: null,
                preprocessTimeMs: null,
                geometryTimeMs: streamCompleteMs,
                totalTimeMs: streamCompleteMs,
                firstChunkReadyTimeMs: firstBatchWaitMs,
                firstChunkPackTimeMs: null,
                firstChunkEmittedTimeMs: null,
                firstChunkEmitTimeMs: null,
              }
            : null,
          metadata: {
            started: metadataParsingStarted,
            metadataStartMs,
            metadataReadCompleteMs,
            metadataParseStartMs,
            spatialReadyMs,
            metadataCompleteMs,
            metadataFailedMs,
            metadataReadDurationMs,
            metadataBufferCopyDurationMs,
            metadataParseDurationMs,
          },
          firstBatchTelemetry: null,
        });

        return;
      }

      // Desktop native streaming path is reserved for truly large IFC files.
      // Mid-size files are more stable on the shared WASM/web loader and still
      // provide full viewer parity without the native streaming complexity.
      if (
        isNativeFileHandle(file)
        && fileName.toLowerCase().endsWith('.ifc')
        && file.size >= HUGE_NATIVE_FILE_THRESHOLD
      ) {
        const harnessRequest = getActiveHarnessRequest();
        const nativeCacheKey = computeNativeCacheKey(file);
        const shouldUseNativeCache = file.size >= CACHE_SIZE_THRESHOLD;
        const hugeNativeMode = file.size >= HUGE_NATIVE_FILE_THRESHOLD;
        const retainAllMeshes = !hugeNativeMode;
        console.log(`[useIfc] Native path load: ${fileName}, size: ${fileSizeMB.toFixed(2)}MB`);
        void logToDesktopTerminal(
          'info',
          `[useIfc] Native path load start: ${fileName} (${fileSizeMB.toFixed(2)} MB) path=${file.path} hugeMode=${hugeNativeMode ? 'yes' : 'no'}`
        );
        setBoundedGeometryMode(hugeNativeMode);
        setGeometryStreamingActive(true);
        setIfcDataStore(null);
        setProgress({ phase: 'Starting native geometry streaming', percent: 10 });

        const geometryProcessor = new GeometryProcessor({
          quality: GeometryQuality.Balanced,
          preferNative: true,
        });

        let estimatedTotal = 0;
        let totalMeshes = 0;
        let totalVertices = 0;
        let totalTriangles = 0;
        const allMeshes: MeshData[] = [];
        let finalCoordinateInfo: CoordinateInfo | null = null;
        let batchCount = 0;
        let modelOpenMs: number | null = null;
        let firstGeometryTime = 0;
        let firstAppendGeometryBatchMs: number | null = null;
        let firstVisibleGeometryMs: number | null = null;
        let jsFirstChunkReceivedMs: number | null = null;
        let lastTotalMeshes = 0;
        let pendingMeshes: MeshData[] = [];
        let loggedFirstAppendStoreState = false;
        let lastRenderTime = 0;
        let streamCompleteMs: number | null = null;
        let metadataStartMs: number | null = null;
        let metadataReadCompleteMs: number | null = null;
        let metadataParseStartMs: number | null = null;
        let spatialReadyMs: number | null = null;
        let metadataCompleteMs: number | null = null;
        let metadataFailedMs: number | null = null;
        let metadataReadDurationMs: number | null = null;
        let metadataBufferCopyDurationMs: number | null = null;
        let metadataParseDurationMs: number | null = null;
        let metadataParsingPromise: Promise<void> | null = null;
        let metadataStallWatchId: ReturnType<typeof globalThis.setInterval> | null = null;
        let lastMetadataActivityTime = 0;
        let currentMetadataActivity = 'idle';
        let firstNativeBatchTelemetry: {
          batchSequence: number;
          payloadKind: string;
          meshCount: number;
          positionsLen: number;
          normalsLen: number;
          indicesLen: number;
          chunkReadyTimeMs: number;
          packTimeMs: number;
          emittedTimeMs: number;
          emitTimeMs: number;
          jsReceivedTimeMs?: number;
        } | null = null;
        let nativeStats: {
          parseTimeMs?: number;
          entityScanTimeMs?: number;
          lookupTimeMs?: number;
          preprocessTimeMs?: number;
          geometryTimeMs?: number;
          totalTimeMs?: number;
          firstChunkReadyTimeMs?: number;
          firstChunkPackTimeMs?: number;
          firstChunkEmittedTimeMs?: number;
          firstChunkEmitTimeMs?: number;
        } | null = null;
        const RENDER_INTERVAL_MS = getRenderIntervalMs(fileSizeMB);
        const NATIVE_PENDING_MESH_THRESHOLD =
          fileSizeMB > 768 ? 8192 :
          fileSizeMB > 512 ? 6144 :
          fileSizeMB > 256 ? 4096 :
          fileSizeMB > 100 ? 2048 :
          512;
        const HUGE_NATIVE_APPEND_CHUNK_SIZE = fileSizeMB > 768 ? 2048 : hugeNativeMode ? 1536 : 0;
        const HUGE_NATIVE_APPEND_YIELD_THRESHOLD = fileSizeMB > 768 ? 8192 : 6144;
        const HUGE_NATIVE_APPEND_YIELD_BUDGET_MS = 10;
        let metadataParsingStarted = false;
        let geometryCompleted = false;
        let fullNativeDataStore: IfcDataStore | null = null;
        let nativeLoadStage: 'open' | 'streamGeometry' | 'finalizeGeometry' | 'hydrateMetadata' | 'complete' = 'open';
        let nativeMetadataSource: 'snapshot' | 'ifc-parse' = 'ifc-parse';
        let nativeMetadataStartGate: 'immediate' | 'afterInteractiveGeometry' | 'afterGeometryComplete' = 'immediate';

        setGeometryResult(null);

        const maybeBuildNativeSpatialIndex = () => {
          if (
            !retainAllMeshes ||
            !geometryCompleted ||
            !fullNativeDataStore ||
            allMeshes.length === 0 ||
            hugeNativeMode ||
            loadSessionRef.current !== currentSession
          ) {
            return;
          }
          buildSpatialIndexGuarded(allMeshes, fullNativeDataStore, setIfcDataStore);
        };

        const flushPendingNativeMeshes = async (
          coordinateInfo: CoordinateInfo | null | undefined,
          totalMeshesSoFar: number,
        ) => {
          if (pendingMeshes.length === 0) {
            return;
          }

          if (firstAppendGeometryBatchMs === null) {
            firstAppendGeometryBatchMs = performance.now() - totalStartTime;
            void logToDesktopTerminal(
              'info',
              `[useIfc] Native first appendGeometryBatch for ${fileName}: ${firstAppendGeometryBatchMs.toFixed(0)}ms`
            );
          }

          void totalMeshesSoFar;

          const appendMeshesToStore = (meshesToAppend: MeshData[]) => {
            const appendGeometryBatchToStore = getViewerStoreApi().getState().appendGeometryBatch;
            if (hugeNativeMode) {
              flushSync(() => {
                appendGeometryBatchToStore(meshesToAppend, coordinateInfo ?? undefined);
              });
              return;
            }
            appendGeometryBatchToStore(meshesToAppend, coordinateInfo ?? undefined);
          };

          if (!hugeNativeMode || HUGE_NATIVE_APPEND_CHUNK_SIZE <= 0 || pendingMeshes.length <= HUGE_NATIVE_APPEND_CHUNK_SIZE) {
            appendMeshesToStore(pendingMeshes);
            if (!loggedFirstAppendStoreState) {
              const stateAfterAppend = useViewerStore.getState();
              void logToDesktopTerminal(
                'info',
                `[useIfc] Store after append for ${fileName}: activeModelId=${stateAfterAppend.activeModelId ?? 'null'} legacyMeshes=${stateAfterAppend.geometryResult?.meshes.length ?? 0} modelMeshes=${stateAfterAppend.models.get(primaryModelId)?.geometryResult?.meshes.length ?? 0} geometryTick=${stateAfterAppend.geometryUpdateTick}`
              );
              loggedFirstAppendStoreState = true;
            }
            if (hugeNativeMode) {
              await yieldToUiThread();
              if (typeof requestAnimationFrame === 'function') {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              }
            }
            pendingMeshes = [];
            markFirstVisibleGeometry();
            return;
          }

          let appendedSinceYield = 0;
          let appendWindowStart = performance.now();
          while (pendingMeshes.length > 0) {
            const chunk = pendingMeshes.splice(0, HUGE_NATIVE_APPEND_CHUNK_SIZE);
            appendMeshesToStore(chunk);
            if (!loggedFirstAppendStoreState) {
              const stateAfterAppend = useViewerStore.getState();
              void logToDesktopTerminal(
                'info',
                `[useIfc] Store after append for ${fileName}: activeModelId=${stateAfterAppend.activeModelId ?? 'null'} legacyMeshes=${stateAfterAppend.geometryResult?.meshes.length ?? 0} modelMeshes=${stateAfterAppend.models.get(primaryModelId)?.geometryResult?.meshes.length ?? 0} geometryTick=${stateAfterAppend.geometryUpdateTick}`
              );
              loggedFirstAppendStoreState = true;
            }
            appendedSinceYield += chunk.length;
            markFirstVisibleGeometry();
            if (pendingMeshes.length === 0) {
              break;
            }

            const shouldYield =
              appendedSinceYield >= HUGE_NATIVE_APPEND_YIELD_THRESHOLD ||
              performance.now() - appendWindowStart >= HUGE_NATIVE_APPEND_YIELD_BUDGET_MS;
            if (shouldYield) {
              await yieldToUiThread();
              if (typeof requestAnimationFrame === 'function') {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              }
              appendedSinceYield = 0;
              appendWindowStart = performance.now();
            }
          }
        };

        const markFirstVisibleGeometry = () => {
          if (firstVisibleGeometryMs !== null) return;
          requestAnimationFrame(() => {
            if (firstVisibleGeometryMs !== null || loadSessionRef.current !== currentSession) return;
            firstVisibleGeometryMs = performance.now() - totalStartTime;
            void logToDesktopTerminal(
              'info',
              `[useIfc] Native first visible geometry for ${fileName}: ${firstVisibleGeometryMs.toFixed(0)}ms`
            );
          });
        };

        const finalizeNativeDataStore = (dataStore: IfcDataStore) => {
          if (dataStore.spatialHierarchy && dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
            const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
            for (const [storeyId, height] of calculatedHeights) {
              dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
            }
          }
          fullNativeDataStore = dataStore;
          setIfcDataStore(dataStore);
          if (geometryCompleted) {
            nativeLoadStage = 'complete';
          }
          finalizePrimaryModel(
            dataStore,
            useViewerStore.getState().geometryResult,
            getSchemaVersion(dataStore),
            {
              loadState: geometryCompleted ? 'complete' : 'hydrating-metadata',
              cacheState: nativeGeometryCacheHit ? 'hit' : shouldUseNativeCache ? 'writing' : 'none',
            },
          );
          updateModel(primaryModelId, {
            geometryLoadState: geometryCompleted ? 'complete' : 'interactive',
            metadataLoadState: 'complete',
            interactiveReady: true,
          });
          maybeBuildNativeSpatialIndex();
        };

        const hydrateNativeSpatialDataStore = (
          nativeMetadata: NonNullable<Awaited<ReturnType<typeof restoreNativeMetadataSnapshot>>>,
        ) => {
          const spatialDataStore = buildIfcDataStoreFromNativeMetadata(nativeMetadata);
          if (!spatialDataStore) {
            return;
          }
          if (spatialDataStore.spatialHierarchy && spatialDataStore.spatialHierarchy.storeyHeights.size === 0 && spatialDataStore.spatialHierarchy.storeyElevations.size > 1) {
            const calculatedHeights = calculateStoreyHeights(spatialDataStore.spatialHierarchy.storeyElevations);
            for (const [storeyId, height] of calculatedHeights) {
              spatialDataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
            }
          }
          const state = useViewerStore.getState();
          const currentGeometryResult =
            state.models.get(primaryModelId)?.geometryResult ??
            state.geometryResult;
          setIfcDataStore(spatialDataStore);
          finalizePrimaryModel(
            spatialDataStore,
            currentGeometryResult,
            nativeMetadata.schemaVersion,
            {
              loadState: geometryCompleted ? 'complete' : 'hydrating-metadata',
              cacheState: nativeGeometryCacheHit ? 'hit' : shouldUseNativeCache ? 'writing' : 'none',
            },
          );
        };

        let nativeMetadataSnapshotHit = false;
        let metadataSnapshotWritePromise: Promise<void> | null = null;

        const queueNativeMetadataSnapshotWrite = (
          dataStore: IfcDataStore,
          sourceBuffer: ArrayBuffer,
        ) => {
          metadataSnapshotWritePromise = (async () => {
            await new Promise<void>((resolve) => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => resolve();
              channel.port2.postMessage(null);
            });
            if (typeof requestAnimationFrame === 'function') {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            await writeNativeMetadataSnapshot(dataStore, sourceBuffer);
          })();
        };

        const writeNativeMetadataSnapshot = async (
          dataStore: IfcDataStore,
          sourceBuffer: ArrayBuffer,
        ): Promise<void> => {
          if (!shouldUseNativeCache || !nativeCacheKey) return;
          try {
            const { setNativeModelSnapshot } = await import('../services/desktop-cache.js');
            const snapshotBuffer = await buildDesktopMetadataSnapshot(dataStore, sourceBuffer);
            await setNativeModelSnapshot(nativeCacheKey, snapshotBuffer);
          } catch (error) {
            console.warn('[useIfc] Failed to persist native metadata snapshot:', error);
            void logToDesktopTerminal(
              'warn',
              `[useIfc] Native metadata snapshot write failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        };

        const noteMetadataActivity = (activity: string) => {
          currentMetadataActivity = activity;
          lastMetadataActivityTime = performance.now();
        };

        const stopMetadataStallWatch = () => {
          if (metadataStallWatchId !== null) {
            globalThis.clearInterval(metadataStallWatchId);
            metadataStallWatchId = null;
          }
        };

        const startMetadataStallWatch = () => {
          stopMetadataStallWatch();
          noteMetadataActivity('starting');
          metadataStallWatchId = globalThis.setInterval(() => {
            if (loadSessionRef.current !== currentSession) {
              stopMetadataStallWatch();
              return;
            }
            const idleForMs = performance.now() - lastMetadataActivityTime;
            if (idleForMs < 8000) return;
            lastMetadataActivityTime = performance.now();
            void logToDesktopTerminal(
              'warn',
              `[useIfc] Metadata stall watch for ${fileName}: stage=${nativeLoadStage} idle=${idleForMs.toFixed(0)}ms phase=${currentMetadataActivity} batches=${batchCount} meshes=${lastTotalMeshes} geometryCompleted=${geometryCompleted}`
            );
          }, 5000);
        };

        const startNativeMetadataParsing = (): Promise<void> | null => {
          if (metadataParsingStarted) return metadataParsingPromise;
          metadataParsingStarted = true;
          nativeLoadStage = 'hydrateMetadata';
          const metadataStartTime = performance.now();
          metadataStartMs = metadataStartTime - totalStartTime;
          let lastMetadataProgressPhase = '';
          let lastMetadataProgressPercent = -1;
          startMetadataStallWatch();
          setMetadataProgress({ phase: 'Bootstrapping metadata', percent: 5, indeterminate: hugeNativeMode });
          updateModel(primaryModelId, {
            loadState: 'hydrating-metadata',
            metadataLoadState: 'bootstrapping',
          });
          void logToDesktopTerminal(
            'info',
            `[useIfc] Native metadata parse start for ${fileName} source=${nativeMetadataSource} gate=${nativeMetadataStartGate}`
          );

          const metadataReadStartTime = performance.now();
          let parseStartTime = 0;
          metadataParsingPromise = (async () => {
            if (hugeNativeMode) {
              noteMetadataActivity('native bootstrap');
              metadataParseStartMs = performance.now() - totalStartTime;
              parseStartTime = performance.now();
              if (nativeMetadataSnapshotHit) {
                const restoredSnapshot = await restoreNativeMetadataSnapshot(nativeCacheKey);
                if (restoredSnapshot && loadSessionRef.current === currentSession) {
                  try {
                    spatialReadyMs = performance.now() - totalStartTime;
                    hydrateNativeSpatialDataStore(restoredSnapshot);
                    updateModel(primaryModelId, {
                      nativeMetadata: restoredSnapshot,
                      schemaVersion: restoredSnapshot.schemaVersion,
                      metadataLoadState: 'spatial-ready',
                      interactiveReady: true,
                    });
                    setMetadataProgress({ phase: 'Restored metadata sidecar', percent: 70 });
                  } catch (error) {
                    nativeMetadataSnapshotHit = false;
                    nativeMetadataSource = 'ifc-parse';
                    void logToDesktopTerminal(
                      'warn',
                      `[useIfc] Native metadata snapshot restore incompatible for ${fileName}, continuing with live bootstrap: ${error instanceof Error ? error.message : String(error)}`
                    );
                  }
                }
              }
              void logToDesktopTerminal(
                'info',
                `[useIfc] Awaiting native metadata bootstrap for ${fileName}`
              );
              const nativeMetadata = await bootstrapNativeMetadata(file.path, nativeCacheKey);
              if (loadSessionRef.current !== currentSession) {
                return null;
              }
              const spatialNodeCount = countNativeSpatialNodes(nativeMetadata.spatialTree);
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native metadata bootstrap resolved for ${fileName}: elapsed=${(performance.now() - parseStartTime).toFixed(0)}ms hasTree=${nativeMetadata.spatialTree ? 'yes' : 'no'} spatialNodes=${spatialNodeCount}`
              );
              metadataReadCompleteMs = performance.now() - totalStartTime;
              metadataReadDurationMs = metadataReadCompleteMs - metadataStartMs;
              spatialReadyMs = performance.now() - totalStartTime;
              void logToDesktopTerminal(
                'info',
                `[useIfc] Applying native metadata to store for ${fileName}`
              );
              hydrateNativeSpatialDataStore(nativeMetadata);
              updateModel(primaryModelId, {
                nativeMetadata,
                schemaVersion: nativeMetadata.schemaVersion,
                metadataLoadState: 'spatial-ready',
                interactiveReady: true,
              });
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native metadata store update complete for ${fileName}`
              );
              setMetadataProgress({ phase: 'Spatial tree ready', percent: 70 });
              if (!nativeMetadataSnapshotHit) {
                void persistNativeMetadataSnapshot(nativeMetadata);
              }
              metadataCompleteMs = performance.now() - totalStartTime;
              metadataParseDurationMs = performance.now() - parseStartTime;
              updateModel(primaryModelId, {
                loadState: geometryCompleted ? 'complete' : 'hydrating-metadata',
                metadataLoadState: 'lazy',
              });
              setMetadataProgress({ phase: 'Metadata ready on demand', percent: 100 });
              return null;
            }

            if (nativeGeometryCacheHit && nativeMetadataSnapshotHit) {
              try {
                const { getNativeModelSnapshot } = await import('../services/desktop-cache.js');
                const snapshotBuffer = await getNativeModelSnapshot(nativeCacheKey);
                if (!snapshotBuffer) {
                  throw new Error(`missing-native-metadata-snapshot:${nativeCacheKey}`);
                }
                metadataReadCompleteMs = performance.now() - totalStartTime;
                metadataReadDurationMs = performance.now() - metadataReadStartTime;
                metadataParseStartMs = performance.now() - totalStartTime;
                parseStartTime = performance.now();
                noteMetadataActivity('snapshot hydrate');
                if (spatialReadyMs === null) {
                  spatialReadyMs = performance.now() - totalStartTime;
                }
                setMetadataProgress({ phase: 'Restoring cached metadata', percent: 80 });
                return restoreDesktopMetadataSnapshot(snapshotBuffer);
              } catch (error) {
                nativeMetadataSnapshotHit = false;
                nativeMetadataSource = 'ifc-parse';
                void logToDesktopTerminal(
                  'warn',
                  `[useIfc] Native metadata snapshot hydration failed for ${fileName}, falling back to IFC parse: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }

            const bytes = await readNativeFile(file.path);
              if (loadSessionRef.current !== currentSession) {
                return null;
              }
              metadataReadCompleteMs = performance.now() - totalStartTime;
              metadataReadDurationMs = performance.now() - metadataReadStartTime;
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native metadata file read complete for ${fileName}: ${metadataReadDurationMs.toFixed(0)}ms`
              );
              const copyStartTime = performance.now();
              const metadataBuffer = toExactArrayBuffer(bytes);
              metadataBufferCopyDurationMs = performance.now() - copyStartTime;
              metadataParseStartMs = performance.now() - totalStartTime;
              parseStartTime = performance.now();
              noteMetadataActivity('parse setup');
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native metadata buffer copy complete for ${fileName}: ${metadataBufferCopyDurationMs.toFixed(0)}ms`
              );

              const parser = new IfcParser();
              const wasmApi = hugeNativeMode ? await getMetadataScanApi() : undefined;
              const dataStore = await parser.parseColumnar(metadataBuffer, {
                wasmApi,
                yieldIntervalMs: hugeNativeMode ? 32 : undefined,
                deferPropertyAtomIndex: hugeNativeMode,
                disableWorkerScan: false,
                onProgress: (progress) => {
                  if (!hugeNativeMode) return;
                  noteMetadataActivity(`progress:${progress.phase}:${Math.round(progress.percent)}`);
                  const roundedPercent = Math.round(progress.percent);
                  const shouldLog =
                    progress.phase !== lastMetadataProgressPhase ||
                    roundedPercent >= lastMetadataProgressPercent + 5 ||
                    roundedPercent === 100;
                  if (!shouldLog) return;
                  setMetadataProgress({
                    phase: `Metadata ${progress.phase}`,
                    percent: roundedPercent,
                    indeterminate: false,
                  });
                  lastMetadataProgressPhase = progress.phase;
                  lastMetadataProgressPercent = roundedPercent;
                  void logToDesktopTerminal(
                    'info',
                    `[useIfc] Native metadata progress for ${fileName}: ${progress.phase} ${roundedPercent}%`
                  );
                },
                onSpatialReady: (partialStore) => {
                  if (loadSessionRef.current !== currentSession) return;
                  noteMetadataActivity('spatial ready');
                  if (spatialReadyMs === null) {
                    spatialReadyMs = performance.now() - totalStartTime;
                  }
                  setMetadataProgress({ phase: 'Spatial tree ready', percent: 70 });
                  if (partialStore.spatialHierarchy && partialStore.spatialHierarchy.storeyHeights.size === 0 && partialStore.spatialHierarchy.storeyElevations.size > 1) {
                    const calculatedHeights = calculateStoreyHeights(partialStore.spatialHierarchy.storeyElevations);
                    for (const [storeyId, height] of calculatedHeights) {
                      partialStore.spatialHierarchy.storeyHeights.set(storeyId, height);
                    }
                  }
                  setIfcDataStore(partialStore);
                  void logToDesktopTerminal(
                    'info',
                    `[useIfc] Native spatial tree ready for ${fileName} at ${(performance.now() - totalStartTime).toFixed(0)}ms`
                  );
                },
                onDiagnostic: (message) => {
                  noteMetadataActivity(`diag:${message}`);
                  void logToDesktopTerminal('info', `[useIfc][diag] ${fileName}: ${message}`);
                },
              });
              queueNativeMetadataSnapshotWrite(dataStore, metadataBuffer);
              return dataStore;
            })()
            .then((dataStore) => {
              stopMetadataStallWatch();
              if (loadSessionRef.current !== currentSession || !dataStore) return;
              metadataCompleteMs = performance.now() - totalStartTime;
              metadataParseDurationMs = parseStartTime > 0 ? performance.now() - parseStartTime : null;
              setMetadataProgress({ phase: 'Metadata ready', percent: 100 });
              finalizeNativeDataStore(dataStore);
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native metadata parse complete for ${fileName}: total=${(performance.now() - metadataStartTime).toFixed(0)}ms read=${metadataReadDurationMs?.toFixed(0) ?? 'n/a'}ms copy=${metadataBufferCopyDurationMs?.toFixed(0) ?? 'n/a'}ms parse=${metadataParseDurationMs?.toFixed(0) ?? 'n/a'}ms`
              );
            })
            .catch((error) => {
              if (loadSessionRef.current !== currentSession) return;
              stopMetadataStallWatch();
              metadataFailedMs = performance.now() - totalStartTime;
              console.warn('[useIfc] Native metadata parsing failed:', error);
              updateModel(primaryModelId, {
                loadState: 'error',
                metadataLoadState: 'error',
                loadError: error instanceof Error ? error.message : String(error),
              });
              setMetadataProgress({ phase: 'Metadata failed', percent: 100 });
              void logToDesktopTerminal(
                'warn',
                `[useIfc] Native metadata parse failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          return metadataParsingPromise;
        };

        const HUGE_NATIVE_METADATA_START_BATCH = 20;
        let metadataStartQueued = false;
        const queueNativeMetadataStart = (reason: string) => {
          if (metadataParsingStarted || metadataStartQueued) return;
          metadataStartQueued = true;
          void logToDesktopTerminal('info', `[useIfc] Queueing metadata hydration for ${fileName} after ${reason}`);
          metadataStartQueued = false;
          if (loadSessionRef.current !== currentSession || metadataParsingStarted) return;
          void logToDesktopTerminal('info', `[useIfc] Starting metadata hydration after ${reason} for ${fileName}`);
          startNativeMetadataParsing();
        };

        let nativeGeometryCacheHit = false;
        if (shouldUseNativeCache) {
          const { hasNativeGeometryCache, hasNativeModelSnapshot } = await import('../services/desktop-cache.js');
          setProgress({ phase: 'Checking cache', percent: 5 });
          setGeometryProgress({ phase: 'Checking geometry cache', percent: 5 });
          nativeGeometryCacheHit = await hasNativeGeometryCache(nativeCacheKey);
          nativeMetadataSnapshotHit = nativeGeometryCacheHit
            ? await hasNativeModelSnapshot(nativeCacheKey)
            : false;
          nativeMetadataSource = nativeMetadataSnapshotHit ? 'snapshot' : 'ifc-parse';
          nativeMetadataStartGate = 'immediate';
          updateModel(primaryModelId, { cacheState: nativeGeometryCacheHit ? 'hit' : 'miss' });
          void logToDesktopTerminal(
            'info',
            nativeGeometryCacheHit
              ? `[useIfc] Native geometry cache hit for ${fileName}`
              : `[useIfc] Native geometry cache miss for ${fileName}`
          );
          if (nativeMetadataStartGate === 'immediate') {
            startNativeMetadataParsing();
          } else {
            void logToDesktopTerminal(
              'info',
              nativeMetadataStartGate === 'afterInteractiveGeometry'
                ? `[useIfc] Deferring metadata hydration until geometry batch ${HUGE_NATIVE_METADATA_START_BATCH} for ${fileName}`
                : `[useIfc] Deferring metadata hydration until geometry complete for ${fileName}`
            );
          }
        }

        if (!shouldUseNativeCache) {
          if (nativeMetadataStartGate === 'immediate') {
            startNativeMetadataParsing();
          } else {
            void logToDesktopTerminal(
              'info',
              `[useIfc] Deferring metadata hydration until geometry complete for ${fileName}`
            );
          }
        }
        await geometryProcessor.init();
        void logToDesktopTerminal('info', `[useIfc] GeometryProcessor.init complete for ${fileName}`);

        const nativeStream = nativeGeometryCacheHit
          ? geometryProcessor.processStreamingCache(nativeCacheKey)
          : geometryProcessor.processStreamingPath(
              file.path,
              file.size,
              shouldUseNativeCache ? nativeCacheKey : undefined,
            );

        for await (const event of nativeStream) {
          const eventReceived = performance.now();

          switch (event.type) {
            case 'start':
              estimatedTotal = event.totalEstimate;
              void logToDesktopTerminal('info', `[useIfc] Native stream start for ${fileName}: estimate=${Math.round(estimatedTotal)}`);
              break;
            case 'model-open':
              nativeLoadStage = 'streamGeometry';
              setProgress({ phase: 'Processing geometry (native precompute)', percent: 50, indeterminate: true });
              setGeometryProgress({ phase: 'Opening native geometry stream', percent: 10, indeterminate: true });
              modelOpenMs = performance.now() - totalStartTime;
              console.log(`[useIfc] Native model opened at ${modelOpenMs.toFixed(0)}ms`);
              void logToDesktopTerminal('info', `[useIfc] Native model opened for ${fileName} at ${modelOpenMs.toFixed(0)}ms`);
              break;
            case 'batch': {
              batchCount++;

              if (batchCount === 1) {
                firstGeometryTime = performance.now() - totalStartTime;
                jsFirstChunkReceivedMs = event.nativeTelemetry?.jsReceivedTimeMs ?? firstGeometryTime;
                firstNativeBatchTelemetry = event.nativeTelemetry ?? null;
                updateModel(primaryModelId, {
                  geometryLoadState: 'interactive',
                  interactiveReady: true,
                });
                console.log(`[useIfc] Native batch #1: ${event.meshes.length} meshes, wait: ${firstGeometryTime.toFixed(0)}ms`);
                void logToDesktopTerminal('info', `[useIfc] Native first batch for ${fileName}: meshes=${event.meshes.length}, wait=${firstGeometryTime.toFixed(0)}ms`);
                if (event.nativeTelemetry) {
                  const transferLagMs = (event.nativeTelemetry.jsReceivedTimeMs ?? 0) - event.nativeTelemetry.emittedTimeMs;
                  void logToDesktopTerminal(
                    'info',
                    `[useIfc] Native first batch transport for ${fileName}: rustReady=${event.nativeTelemetry.chunkReadyTimeMs.toFixed(0)}ms pack=${event.nativeTelemetry.packTimeMs.toFixed(0)}ms emit=${event.nativeTelemetry.emitTimeMs.toFixed(0)}ms rustEmitted=${event.nativeTelemetry.emittedTimeMs.toFixed(0)}ms jsReceived=${(event.nativeTelemetry.jsReceivedTimeMs ?? 0).toFixed(0)}ms transfer=${transferLagMs.toFixed(0)}ms`
                  );
                }
              } else if (batchCount % 20 === 0) {
                void logToDesktopTerminal('info', `[useIfc] Native batch milestone for ${fileName}: batch=${batchCount}, totalMeshes=${event.totalSoFar}`);
              }

              for (let i = 0; i < event.meshes.length; i++) {
                const mesh = event.meshes[i];
                if (retainAllMeshes) {
                  allMeshes.push(mesh);
                }
                totalVertices += mesh.positions.length / 3;
                totalTriangles += mesh.indices.length / 3;
              }
              finalCoordinateInfo = event.coordinateInfo ?? null;
              totalMeshes = event.totalSoFar;
              lastTotalMeshes = event.totalSoFar;

              for (let i = 0; i < event.meshes.length; i++) pendingMeshes.push(event.meshes[i]);

              if (
                nativeMetadataStartGate === 'afterInteractiveGeometry' &&
                !metadataParsingStarted &&
                batchCount >= HUGE_NATIVE_METADATA_START_BATCH &&
                firstAppendGeometryBatchMs !== null
              ) {
                queueNativeMetadataStart(`geometry batch ${batchCount}`);
              }

              const timeSinceLastRender = eventReceived - lastRenderTime;
              const allowTimeBasedFlush = !hugeNativeMode || ENABLE_HUGE_TIME_FLUSH;
              const shouldRender =
                batchCount === 1 ||
                pendingMeshes.length >= NATIVE_PENDING_MESH_THRESHOLD ||
                (allowTimeBasedFlush && timeSinceLastRender >= RENDER_INTERVAL_MS);

              if (shouldRender && pendingMeshes.length > 0) {
                await flushPendingNativeMeshes(event.coordinateInfo, totalMeshes);
                lastRenderTime = eventReceived;

                const progressPercent = 50 + Math.min(45, (totalMeshes / Math.max(estimatedTotal / 10, totalMeshes || 1)) * 45);
                setProgress({
                  phase: `Rendering geometry (${totalMeshes} meshes)`,
                  percent: progressPercent,
                  indeterminate: false,
                });
                setGeometryProgress({
                  phase: `Rendering geometry (${totalMeshes} meshes)`,
                  percent: Math.min(99, progressPercent),
                  indeterminate: false,
                });
              }
              break;
            }
            case 'complete':
              nativeLoadStage = 'finalizeGeometry';
              geometryCompleted = true;
              streamCompleteMs = performance.now() - totalStartTime;
              if (pendingMeshes.length > 0) {
                await flushPendingNativeMeshes(event.coordinateInfo, lastTotalMeshes);
              }

              finalCoordinateInfo = event.coordinateInfo;
              updateCoordinateInfo(finalCoordinateInfo);
              maybeBuildNativeSpatialIndex();
              if (nativeMetadataStartGate === 'afterGeometryComplete' && !metadataParsingStarted) {
                queueNativeMetadataStart('geometry complete');
              }
              setProgress({
                phase: hugeNativeMode ? 'Geometry ready, hydrating metadata' : 'Complete',
                percent: 100,
              });
              setGeometryProgress({
                phase: 'Geometry interactive',
                percent: 100,
              });
              setMetadataProgress(
                hugeNativeMode
                  ? { phase: 'Preparing metadata', percent: nativeMetadataStartGate === 'afterGeometryComplete' ? 5 : 0, indeterminate: false }
                  : { phase: 'Metadata complete', percent: 100 }
              );
              updateModel(primaryModelId, {
                loadState: hugeNativeMode ? 'hydrating-metadata' : 'complete',
                geometryLoadState: 'complete',
                metadataLoadState: hugeNativeMode ? 'bootstrapping' : 'complete',
                interactiveReady: true,
                cacheState: nativeGeometryCacheHit ? 'hit' : shouldUseNativeCache ? 'writing' : 'none',
              });
              console.log(`[useIfc] Native geometry streaming complete: ${batchCount} batches, ${lastTotalMeshes} meshes`);
              void logToDesktopTerminal(
                'info',
                `[useIfc] Native stream complete for ${fileName}: stage=${nativeLoadStage} batches=${batchCount}, meshes=${lastTotalMeshes}`
              );
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (loadSessionRef.current === currentSession) {
                setGeometryStreamingActive(false);
              }
              break;
          }
        }

        nativeStats = geometryProcessor.getLastNativeStats();

        const totalElapsedMs = performance.now() - totalStartTime;
        console.log(
          `[useIfc] ✓ ${fileName} (${fileSizeMB.toFixed(1)}MB) → ` +
          `${lastTotalMeshes} meshes, ${(totalVertices / 1000).toFixed(0)}k vertices | ` +
          `first: ${firstGeometryTime.toFixed(0)}ms, total: ${totalElapsedMs.toFixed(0)}ms`
        );
        if (nativeStats) {
          void logToDesktopTerminal(
            'info',
            `[useIfc] Native timings for ${fileName}: scan=${nativeStats.entityScanTimeMs ?? 0}ms lookup=${nativeStats.lookupTimeMs ?? 0}ms preprocess=${nativeStats.preprocessTimeMs ?? 0}ms parse=${nativeStats.parseTimeMs ?? 0}ms geometry=${nativeStats.geometryTimeMs ?? 0}ms total=${nativeStats.totalTimeMs ?? 0}ms`
          );
        }
        if (!metadataParsingStarted) {
          console.warn('[useIfc] Native large-file mode completed without metadata parsing');
          void logToDesktopTerminal('warn', `[useIfc] Native large-file mode completed without metadata parsing for ${fileName}`);
        }
        if (harnessRequest?.waitForMetadataCompletion) {
          if (!metadataParsingStarted) {
            startNativeMetadataParsing();
          }
          if (metadataParsingPromise) {
            await metadataParsingPromise;
          }
          if (metadataSnapshotWritePromise) {
            await metadataSnapshotWritePromise;
          }
        }
        if (firstVisibleGeometryMs === null && firstAppendGeometryBatchMs !== null) {
          await new Promise<void>((resolve) => {
            const fallbackTimer = globalThis.setTimeout(() => {
              if (firstVisibleGeometryMs === null && loadSessionRef.current === currentSession) {
                firstVisibleGeometryMs = firstAppendGeometryBatchMs;
              }
              resolve();
            }, 250);
            requestAnimationFrame(() => {
              globalThis.clearTimeout(fallbackTimer);
              if (firstVisibleGeometryMs === null && loadSessionRef.current === currentSession) {
                firstVisibleGeometryMs = performance.now() - totalStartTime;
              }
              resolve();
            });
          });
        }
        if (hugeNativeMode) {
          setLoading(false);
        }
        const telemetryElapsedMs = performance.now() - totalStartTime;
        await finalizeActiveHarnessRun({
          schemaVersion: 1,
          source: 'desktop-native',
          mode: harnessRequest ? 'startup-harness' : 'manual',
          success: true,
          runLabel: harnessRequest?.runLabel,
          cache: {
            key: nativeCacheKey,
            hit: nativeGeometryCacheHit,
            manifestMeshCount: null,
            manifestShardCount: null,
          },
          file: {
            path: file.path,
            name: file.name,
            sizeBytes: file.size,
            sizeMB: fileSizeMB,
          },
          timings: {
            modelOpenMs,
            firstBatchWaitMs: firstGeometryTime || null,
            firstAppendGeometryBatchMs,
            firstVisibleGeometryMs,
            streamCompleteMs,
            totalWallClockMs: telemetryElapsedMs,
            metadataStartMs,
            metadataReadCompleteMs,
            metadataParseStartMs,
            spatialReadyMs,
            metadataCompleteMs,
            metadataFailedMs,
            metadataReadDurationMs,
            metadataBufferCopyDurationMs,
            metadataParseDurationMs,
          },
          batches: {
            estimatedTotal,
            totalBatches: batchCount,
            totalMeshes: lastTotalMeshes,
            firstBatchMeshes: firstNativeBatchTelemetry?.meshCount ?? null,
            firstPayloadKind: firstNativeBatchTelemetry?.payloadKind ?? null,
          },
          nativeStats: nativeStats
            ? {
                parseTimeMs: nativeStats.parseTimeMs ?? null,
                entityScanTimeMs: nativeStats.entityScanTimeMs ?? null,
                lookupTimeMs: nativeStats.lookupTimeMs ?? null,
                preprocessTimeMs: nativeStats.preprocessTimeMs ?? null,
                geometryTimeMs: nativeStats.geometryTimeMs ?? null,
                totalTimeMs: nativeStats.totalTimeMs ?? null,
                firstChunkReadyTimeMs: nativeStats.firstChunkReadyTimeMs ?? null,
                firstChunkPackTimeMs: nativeStats.firstChunkPackTimeMs ?? null,
                firstChunkEmittedTimeMs: nativeStats.firstChunkEmittedTimeMs ?? null,
                firstChunkEmitTimeMs: nativeStats.firstChunkEmitTimeMs ?? null,
              }
            : null,
          metadata: {
            started: metadataParsingStarted,
            metadataStartMs,
            metadataReadCompleteMs,
            metadataParseStartMs,
            spatialReadyMs,
            metadataCompleteMs,
            metadataFailedMs,
            metadataReadDurationMs,
            metadataBufferCopyDurationMs,
            metadataParseDurationMs,
          },
          firstBatchTelemetry: firstNativeBatchTelemetry
            ? {
                batchSequence: firstNativeBatchTelemetry.batchSequence,
                payloadKind: firstNativeBatchTelemetry.payloadKind,
                meshCount: firstNativeBatchTelemetry.meshCount,
                positionsLen: firstNativeBatchTelemetry.positionsLen,
                normalsLen: firstNativeBatchTelemetry.normalsLen,
                indicesLen: firstNativeBatchTelemetry.indicesLen,
                rustChunkReadyMs: firstNativeBatchTelemetry.chunkReadyTimeMs,
                rustPackMs: firstNativeBatchTelemetry.packTimeMs,
                rustEmittedMs: firstNativeBatchTelemetry.emittedTimeMs,
                rustEmitMs: firstNativeBatchTelemetry.emitTimeMs,
                jsReceivedMs: jsFirstChunkReceivedMs,
                transportToJsMs:
                  jsFirstChunkReceivedMs !== null
                    ? jsFirstChunkReceivedMs - firstNativeBatchTelemetry.emittedTimeMs
                    : null,
                appendAfterReceiveMs:
                  jsFirstChunkReceivedMs !== null && firstAppendGeometryBatchMs !== null
                    ? firstAppendGeometryBatchMs - jsFirstChunkReceivedMs
                    : null,
                visibleAfterAppendMs:
                  firstVisibleGeometryMs !== null && firstAppendGeometryBatchMs !== null
                    ? firstVisibleGeometryMs - firstAppendGeometryBatchMs
                    : null,
              }
            : null,
        });
        if (!hugeNativeMode) {
          setLoading(false);
        }
        return;
      }

      // Read file from disk
      const fileReadStart = performance.now();
      const buffer = isNativeFileHandle(file)
        ? toExactArrayBuffer(await readNativeFile(file.path))
        : await file.arrayBuffer();
      const fileReadMs = performance.now() - fileReadStart;
      console.log(`[useIfc] File: ${file.name}, size: ${fileSizeMB.toFixed(2)}MB, read in ${fileReadMs.toFixed(0)}ms`);

      // Detect file format (IFCX/IFC5 vs IFC4 STEP vs GLB)
      const format = detectFormat(buffer);

      // IFCX files must be parsed client-side (server only supports IFC4 STEP)
      if (format === 'ifcx') {
        setProgress({ phase: 'Parsing IFCX (client-side)', percent: 10 });
        setGeometryStreamingActive(false);

        try {
          const result = await parseIfcxViewerModel(buffer, setProgress);
          setGeometryResult(result.geometryResult);
          setIfcDataStore(result.dataStore);
          finalizePrimaryModel(result.dataStore, result.geometryResult, result.schemaVersion);

          setProgress({ phase: 'Complete', percent: 100 });
          setLoading(false);
          return;
        } catch (err: unknown) {
          if (err instanceof Error && err.message === 'overlay-only-ifcx') {
            console.warn(`[useIfc] IFCX file "${file.name}" has no geometry - this appears to be an overlay file that adds properties to a base model.`);
            console.warn('[useIfc] To use this file, load it together with a base IFCX file (select both files at once).');
            setError(`"${file.name}" is an overlay file with no geometry. Please load it together with a base IFCX file (select all files at once).`);
            updateModel(primaryModelId, { loadState: 'error', loadError: 'overlay-only-ifcx' });
            setLoading(false);
            return;
          }
          console.error('[useIfc] IFCX parsing failed:', err);
          const message = err instanceof Error ? err.message : String(err);
          updateModel(primaryModelId, { loadState: 'error', loadError: message });
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
          setGeometryResult(result.geometryResult);
          setIfcDataStore(null);
          finalizePrimaryModel(null, result.geometryResult, result.schemaVersion);

          setProgress({ phase: 'Complete', percent: 100 });

          setLoading(false);
          return;
        } catch (err: unknown) {
          console.error('[useIfc] GLB parsing failed:', err);
          const message = err instanceof Error ? err.message : String(err);
          updateModel(primaryModelId, { loadState: 'error', loadError: message });
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
      const cacheKey = `ifc-${buffer.byteLength}-${fingerprint}-v4`;

      if (buffer.byteLength >= CACHE_SIZE_THRESHOLD) {
        setProgress({ phase: 'Checking cache', percent: 5 });
        const cacheResult = await getCached(cacheKey);
        if (cacheResult) {
          const cacheLoadResult = await loadFromCache(cacheResult, file.name, cacheKey);
          if (cacheLoadResult.success) {
            const state = useViewerStore.getState();
            finalizePrimaryModel(state.ifcDataStore, state.geometryResult, getSchemaVersion(state.ifcDataStore), {
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
      // Only for IFC4 STEP files (server doesn't support IFCX)
      if (format === 'ifc' && USE_SERVER && SERVER_URL && SERVER_URL !== '') {
        // Pass buffer directly - server uses File object for parsing, buffer is only for size checks
        const serverSuccess = await loadFromServer(file, buffer, () => loadSessionRef.current !== currentSession);
        if (serverSuccess) {
          const state = useViewerStore.getState();
          finalizePrimaryModel(state.ifcDataStore, state.geometryResult, getSchemaVersion(state.ifcDataStore));
          console.log(`[useIfc] TOTAL LOAD TIME (server): ${(performance.now() - totalStartTime).toFixed(0)}ms`);
          setLoading(false);
          return;
        }
        // Server not available - continue with local WASM (no error logging needed)
      } else if (format === 'unknown') {
      }

      // Using local WASM parsing
      setProgress({ phase: 'Starting geometry streaming', percent: 10 });
      setGeometryStreamingActive(true);

      const shouldUseDesktopStableWasmGeometry =
        isNativeFileHandle(file)
        && fileName.toLowerCase().endsWith('.ifc')
        && file.size < HUGE_NATIVE_FILE_THRESHOLD;

      // Initialize geometry processor first (WASM init is fast if already loaded)
      const geometryProcessor = new GeometryProcessor({
        quality: GeometryQuality.Balanced,
        preferNative: false,
      });
      await geometryProcessor.init();

      // Data model parsing runs IN PARALLEL with geometry streaming.
      // Entity scanning uses a Web Worker (non-blocking, ~1.2s).
      // Columnar parse uses time-sliced yielding (~2.3s, 60fps maintained).
      // Neither depends on geometry output — both just need the raw buffer.
      let resolveDataStore: (dataStore: IfcDataStore) => void;
      let rejectDataStore: (err: unknown) => void;
      const dataStorePromise = new Promise<IfcDataStore>((resolve, reject) => {
        resolveDataStore = resolve;
        rejectDataStore = reject;
      });

      const startDataModelParsing = () => {
        const parser = new IfcParser();
        metadataStartMs = performance.now() - totalStartTime;
        console.log(`[useIfc] Data model parsing start for ${file.name}: ${metadataStartMs.toFixed(0)}ms`);
        // Do not share the geometry processor's WASM API with the parser on
        // desktop fallback loads. Concurrent access can corrupt the WASM state
        // and freeze or crash the viewer. Let the parser use worker/TS scanning
        // instead.
        const parserWasmApi = isNativeFileHandle(file) ? undefined : geometryProcessor.getApi();
        parser.parseColumnar(buffer, {
          wasmApi: parserWasmApi,
          // Emit spatial hierarchy EARLY — lets the panel render while
          // property/association parsing continues (~0.5-1s earlier).
          onSpatialReady: (partialStore) => {
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
            setIfcDataStore(partialStore);
          },
        }).then(dataStore => {
          if (loadSessionRef.current !== currentSession) return;
          metadataCompleteMs = performance.now() - totalStartTime;
          // Calculate storey heights from elevation differences if not already populated
          if (dataStore.spatialHierarchy && dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
            const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
            for (const [storeyId, height] of calculatedHeights) {
              dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
            }
          }

          // Update with full data (includes property/association maps)
          setIfcDataStore(dataStore);
          console.log(`[useIfc] Data model parsing complete for ${file.name}: ${metadataCompleteMs.toFixed(0)}ms`);
          resolveDataStore(dataStore);
        }).catch(err => {
          metadataFailedMs = performance.now() - totalStartTime;
          console.error('[useIfc] Data model parsing failed:', err);
          console.log(`[useIfc] Data model parsing failed for ${file.name}: ${metadataFailedMs.toFixed(0)}ms`);
          rejectDataStore(err);
        });
      };

      // Start data model parsing IMMEDIATELY — runs in parallel with geometry.
      // Entity scan uses Web Worker (off main thread), columnar parse yields
      // every ~4ms to maintain 60fps navigation during geometry streaming.
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

      // Clear existing geometry result
      setGeometryResult(null);

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

      try {
        // Use dynamic batch sizing for optimal throughput
        const dynamicBatchConfig = getDynamicBatchConfig(fileSizeMB);
        const geometryEvents = shouldUseDesktopStableWasmGeometry
          ? geometryProcessor.processStreaming(new Uint8Array(buffer), undefined, dynamicBatchConfig)
          : geometryProcessor.processAdaptive(new Uint8Array(buffer), {
              sizeThreshold: 2 * 1024 * 1024, // 2MB threshold
              batchSize: dynamicBatchConfig, // Dynamic batches: small first, then large
            });
        const geometryIterator = geometryEvents[Symbol.asyncIterator]();
        let geometryIteratorClosed = false;
        closeGeometryIterator = async () => {
          if (geometryIteratorClosed || typeof geometryIterator.return !== 'function') return;
          geometryIteratorClosed = true;
          try {
            await geometryIterator.return();
          } catch {
            // Ignore iterator shutdown failures during recovery.
          }
        };

        while (true) {
          const watchdogMs = getGeometryStreamWatchdogMs(
            shouldUseDesktopStableWasmGeometry,
            batchCount,
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

              break;
            }
            case 'complete':
              streamCompleteMs = performance.now() - totalStartTime;
              // Flush any remaining pending meshes
              if (pendingMeshes.length > 0) {
                if (firstAppendGeometryBatchMs === null) {
                  firstAppendGeometryBatchMs = performance.now() - totalStartTime;
                  console.log(`[useIfc] First appendGeometryBatch for ${file.name}: ${firstAppendGeometryBatchMs.toFixed(0)}ms`);
                }
                appendGeometryBatch(pendingMeshes, event.coordinateInfo);
                pendingMeshes = [];
                markFirstVisibleGeometry();
              }

              finalCoordinateInfo = event.coordinateInfo ?? null;

              // Data model parsing already started in parallel (see above).
              // No need to start it here — it runs concurrently with geometry.

              // Apply all accumulated color updates in a single store update
              // instead of one updateMeshColors() call per colorUpdate event.
              if (cumulativeColorUpdates.size > 0) {
                updateMeshColors(cumulativeColorUpdates);
              }

              // Store captured RTC offset in coordinate info for multi-model alignment
              if (finalCoordinateInfo && capturedRtcOffset) {
                finalCoordinateInfo.wasmRtcOffset = capturedRtcOffset;
              }

              // Update geometry result with final coordinate info
              updateCoordinateInfo(finalCoordinateInfo);

              setProgress({ phase: 'Complete', percent: 100 });
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (loadSessionRef.current === currentSession) {
                setGeometryStreamingActive(false);
              }
              console.log(`[useIfc] Geometry streaming complete: ${batchCount} batches, ${lastTotalMeshes} meshes`);
              console.log(`[useIfc] Stream complete for ${file.name}: ${streamCompleteMs.toFixed(0)}ms`);

              // Build spatial index and cache in background (non-blocking)
              // Wait for data model to complete first
              dataStorePromise.then(async dataStore => {
                // Guard: skip if user loaded a new file since this load started
                if (loadSessionRef.current !== currentSession) return;
                finalizePrimaryModel(dataStore, useViewerStore.getState().geometryResult, getSchemaVersion(dataStore), {
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
                updateModel(primaryModelId, {
                  loadState: 'error',
                  loadError: err instanceof Error ? err.message : String(err),
                });
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
        if (loadSessionRef.current !== currentSession) return;
        console.error('[useIfc] Error in processing:', err);
        setError(err instanceof Error ? err.message : 'Unknown error during geometry processing');
        setLoading(false);
        setGeometryStreamingActive(false);
        return;
      }

      if (loadSessionRef.current !== currentSession) return;

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
      updateModel(primaryModelId, {
        loadState: 'error',
        loadError: err instanceof Error ? err.message : String(err),
      });
      if (isNativeFileHandle(file)) {
        const harnessRequest = getActiveHarnessRequest();
        await finalizeActiveHarnessRun({
          schemaVersion: 1,
          source: 'desktop-native',
          mode: harnessRequest ? 'startup-harness' : 'manual',
          success: false,
          runLabel: harnessRequest?.runLabel,
          cache: {
            key: computeNativeCacheKey(file),
            hit: null,
            manifestMeshCount: null,
            manifestShardCount: null,
          },
          file: {
            path: file.path,
            name: file.name,
            sizeBytes: file.size,
            sizeMB: file.size / (1024 * 1024),
          },
          timings: {
            totalWallClockMs: performance.now() - totalStartTime,
          },
          batches: {},
          nativeStats: null,
          metadata: null,
          firstBatchTelemetry: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      void logToDesktopTerminal('error', `[useIfc] Load failed: ${err instanceof Error ? err.message : String(err)}`);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
      setGeometryStreamingActive(false);
    }
  }, [setLoading, setGeometryStreamingActive, setError, setProgress, setIfcDataStore, setGeometryResult, appendGeometryBatch, updateMeshColors, updateCoordinateInfo, loadFromCache, saveToCache, loadFromServer]);

  return { loadFile };
}

export default useIfcLoader;
