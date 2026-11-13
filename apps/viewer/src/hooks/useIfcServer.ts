/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for server-side IFC parsing
 * Manages ServerClient instance, server reachability checking,
 * and streaming/Parquet/JSON parsing paths
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { useCallback } from 'react';
import { useServerModelProperties } from './ingest/useServerModelProperties.js';
import { useViewerStore } from '../store/index.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import {
  IfcServerClient,
  decodeDataModel,
  isProcessedModelRef,
  type ProcessedModelRef,
  type ParquetBatch,
  type ParquetParseResponse,
  type ParquetStreamResult,
  type ParseResponse,
  type ModelMetadata,
  type ProcessingStats,
} from '@ifc-lite/server-client';

import { getProcessingServerUrl } from '../lib/processed-model.js';
import { isServerAvailable, isServerReachable } from './ingest/serverAvailability.js';
import { ProcessedModelUnavailable } from './ingest/processedModel.js';
import {
  createEmptyBounds,
  updateBoundsFromPositions,
  calculateMeshBounds,
  MAX_VALID_COORD,
  getServerStreamIntervalMs,
} from '../utils/localParsingUtils.js';

// Server data model conversion
import { convertServerDataModel, type ServerParseResult } from '../utils/serverDataModel.js';
import { convertServerMesh } from '../utils/serverMesh.js';
import { serverOriginShift } from '../utils/serverOriginShift.js';

/** Server parse result type - union of streaming and non-streaming responses */
type ServerParseResultType = ParquetParseResponse | ParquetStreamResult | ParseResponse;

/**
 * Hook for server-side IFC file parsing
 * Handles server reachability, streaming/Parquet/JSON parsing paths,
 * and ServerClient lifecycle
 */
export function useIfcServer() {
  const { start: hydrateProperties, cancel: cancelProperties } = useServerModelProperties();
  /**
   * Load from server - uses server-side PARALLEL parsing for maximum speed
   * Uses full parse endpoint (not streaming) for all-at-once parallel processing
   *
   * Store actions are retrieved via getState() inside the callback to avoid
   * subscribing the hook to the entire store (which would cause unnecessary re-renders).
   */
  const loadFromServer = useCallback(async (
    /** The IFC to upload, or a model the server already processed (then `buffer` is unused: there are no bytes here). */
    file: File | ProcessedModelRef,
    buffer: ArrayBuffer | SharedArrayBuffer,
    /**
     * Optional staleness check — returns true if this load has been
     * superseded. Same contract as `loadFromCache`'s (useIfcCache.ts:194):
     * re-checked before every write into the active model slot, including
     * inside the streaming batch callback below — a stale batch (or a stale
     * post-stream/post-parse result) writes nothing.
     */
    isStale: (() => boolean) | undefined,
    signal: AbortSignal | undefined,
    modelId: string,
  ): Promise<boolean> => {
    cancelProperties(modelId);
    const { setProgress, setGeometryResult } = useViewerStore.getState();
    // A processed model has no fallback, so its failures reach the caller to be worded; an
    // upload's stay silent here and fall back to local processing.
    const processed = isProcessedModelRef(file);
    try {
      setProgress({ phase: 'Connecting to server', percent: 5 });

      const serverUrl = getProcessingServerUrl(); // read per load: a host may set it at runtime
      const client = new IfcServerClient({ baseUrl: serverUrl });

      // Silent server availability check (cached, no error logging). A processed model skips the
      // health round trip: its geometry request asks the same question, and a down server ends in
      // the same error card either way.
      const serverAvailable = processed ? isServerReachable(serverUrl) : await isServerAvailable(serverUrl, client);
      if (!serverAvailable) {
        if (processed) throw new ProcessedModelUnavailable(serverUrl === '' ? 'no-server' : 'unreachable');
        return false; // Silently fall back - caller handles logging
      }
      // The route follows the size the server parses; the model info shows the file as opened.
      // They differ for an .ifcZIP upload, whose buffer is already unwrapped.
      const parsedBytes = processed ? file.bytes : buffer.byteLength;
      const openedBytes = processed ? file.bytes : file.size;

      if (isStale?.()) return false;
      setProgress({ phase: 'Processing on server (parallel)', percent: 15 });

      // Check if Parquet is supported (requires parquet-wasm)
      const parquetSupported = await client.isParquetSupported();

      // A newer load (or model removal) may have superseded this one while
      // the capability check above was in flight — same reasoning as every
      // other post-await re-check in this function: an `await` is a window
      // for `isStale` to flip, not just the streaming/parse calls below.
      if (isStale?.()) return false;

      let allMeshes: MeshData[];
      let result: ServerParseResultType;

      // Use streaming for large files (>150MB) for progressive rendering
      // Smaller files use non-streaming path (faster - avoids ~1.1s background re-processing overhead)
      // Streaming overhead: ~67 batch serializations + background re-processing (~1100ms)
      // Non-streaming: single serialization (~218ms for 60k meshes)
      // Threshold chosen to balance UX (progressive rendering) vs performance (overhead)
      const fileSizeMB = parsedBytes / (1024 * 1024);
      const USE_STREAMING_THRESHOLD_MB = 150;
      // A processed model of unknown size streams: the streamed route works at any size.
      const streaming = parquetSupported && (fileSizeMB > USE_STREAMING_THRESHOLD_MB || (processed && parsedBytes === 0));

      if (streaming) {
        // STREAMING PATH - for large files, render progressively
        allMeshes = [];
        let totalVertices = 0;
        let totalTriangles = 0;
        let cacheKey = '';
        let streamMetadata: ModelMetadata | null = null;
        let streamStats: ProcessingStats | null = null;
        let batchCount = 0;

        // Progressive bounds calculation
        const bounds = createEmptyBounds();

        // Throttle server streaming updates - large files get less frequent UI updates
        let lastServerStreamRenderTime = 0;
        const SERVER_STREAM_INTERVAL_MS = getServerStreamIntervalMs(parsedBytes === 0 ? Infinity : fileSizeMB); // unknown size: the large-file throttle

        // Use streaming endpoint with batch callback
        const streamResult = await client.parseParquetStream(file, (batch: ParquetBatch) => {
          // Re-check on every batch: `onBatch` fires once per batch of ONE
          // long-running awaited stream, so a newer load can own the active
          // slot by the time any batch after the first arrives. Same
          // contract, same reason, as useIfcCache.ts's per-chunk guard in its
          // streaming loop — without it a superseded load's later batches
          // keep painting into the model the user just opened.
          if (isStale?.()) return;

          batchCount++;

          // Convert batch meshes to viewer format (snake_case to camelCase, number[] to TypedArray)
          const batchMeshes: MeshData[] = batch.meshes.map(convertServerMesh);

          // Update bounds incrementally
          for (const mesh of batchMeshes) {
            // Fold the per-element local-frame origin (position + origin,
            // issue #1841). Without it an origin-relative mesh contributes only
            // its small LOCAL coordinates and the camera fits onto the scene
            // origin. NOTE the frame: `origin` is the element's local frame
            // WITHIN the server's already-RTC-shifted space, so these bounds
            // stay SHIFTED — `originalBounds` below still reconstructs world by
            // adding `originShift`. This mirrors the non-streaming path, whose
            // `calculateMeshBounds` folds origin and then adds originShift too.
            updateBoundsFromPositions(bounds, mesh.positions, MAX_VALID_COORD, mesh.origin ?? null);
            totalVertices += mesh.positions.length / 3;
            totalTriangles += mesh.indices.length / 3;
          }

          // Add to collection (use loop to avoid stack overflow with large batches)
          for (let i = 0; i < batchMeshes.length; i++) allMeshes.push(batchMeshes[i]);

          // THROTTLED PROGRESSIVE RENDERING: Update UI at controlled rate
          // First batch renders immediately, subsequent batches throttled
          const now = performance.now();
          const shouldRender = batchCount === 1 || (now - lastServerStreamRenderTime >= SERVER_STREAM_INTERVAL_MS);

          if (shouldRender) {
            lastServerStreamRenderTime = now;

            // Update progress
            setProgress({
              phase: `Streaming batch ${batchCount}`,
              percent: Math.min(15 + (batchCount * 5), 85)
            });

            // PROGRESSIVE RENDERING: Set geometry after each batch
            // This allows the user to see geometry appearing progressively
            const coordinateInfo = {
              originShift: { x: 0, y: 0, z: 0 },
              originalBounds: bounds,
              shiftedBounds: bounds,
              hasLargeCoordinates: false,
            };

            setGeometryResult({
              meshes: [...allMeshes], // Clone to trigger re-render
              totalVertices,
              totalTriangles,
              coordinateInfo,
            });
          }
        });

        // Re-check after the stream's single big await resolves: supersession
        // can land at any point during it, including after the LAST batch's
        // onBatch call returns. Without this the "final geometry set with
        // complete bounds" write below still lands in the active slot for a
        // load nobody owns any more.
        if (isStale?.()) return false;

        cacheKey = streamResult.cache_key;
        streamMetadata = streamResult.metadata;
        streamStats = streamResult.stats;

        // Build final result object for data model fetching
        // Note: meshes field is omitted - allMeshes is passed separately to convertServerDataModel
        result = {
          cache_key: cacheKey,
          metadata: streamMetadata,
          stats: streamStats,
        } as ParquetStreamResult;

        // Final geometry set with complete bounds
        // Server already applies RTC shift to mesh positions, so bounds are shifted
        // Reconstruct originalBounds by adding originShift back to shifted bounds
        // (Y-up like the meshes: the server leaves the shift in IFC Z-up.)
        const originShift = serverOriginShift(streamMetadata?.coordinate_info?.origin_shift);
        const finalCoordinateInfo = {
          originShift,
          // Original bounds = shifted bounds + originShift (reconstruct world coordinates)
          originalBounds: {
            min: {
              x: bounds.min.x + originShift.x,
              y: bounds.min.y + originShift.y,
              z: bounds.min.z + originShift.z,
            },
            max: {
              x: bounds.max.x + originShift.x,
              y: bounds.max.y + originShift.y,
              z: bounds.max.z + originShift.z,
            },
          },
          // Shifted bounds = bounds as-is (server already applied shift)
          shiftedBounds: bounds,
          // Note: server returns is_geo_referenced but it really means "had large coordinates"
          hasLargeCoordinates: streamMetadata?.coordinate_info?.is_geo_referenced ?? false,
        };

        setGeometryResult({
          meshes: allMeshes,
          totalVertices,
          totalTriangles,
          coordinateInfo: finalCoordinateInfo,
        });

      } else if (parquetSupported) {
        // NON-STREAMING PATH - for smaller files, use batch request (with cache check)
        // Use Parquet endpoint - much smaller payload (~15x compression)
        const parquetResult = await client.parseParquet(file);
        // Re-check right after this await, before the first write below —
        // same reason as the streaming re-check above: a non-streaming parse
        // is still one awaited network round trip a newer load can outrun.
        if (isStale?.()) return false;
        result = parquetResult;

        setProgress({ phase: 'Converting meshes', percent: 70 });

        // Convert server mesh format to viewer format (TypedArrays)
        allMeshes = parquetResult.meshes.map(convertServerMesh);
      } else {
        // Fallback to JSON endpoint
        if (processed) throw new ProcessedModelUnavailable('unsupported');
        result = await client.parse(file);
        if (isStale?.()) return false;

        setProgress({ phase: 'Converting meshes', percent: 70 });

        // Convert server mesh format to viewer format
        const jsonResult = result as ParseResponse;
        allMeshes = jsonResult.meshes.map(convertServerMesh);
      }

      // For non-streaming paths, calculate bounds and set geometry
      // (Streaming path already handled this progressively)
      if (!streaming) {
        // Calculate bounds from mesh positions for camera fitting
        // IMPORTANT: Server already applies RTC shift to mesh positions, so bounds calculated
        // from mesh positions are ALREADY in shifted coordinates (small values near origin).
        // We must NOT subtract originShift again - that would give huge negative bounds!
        const { bounds } = calculateMeshBounds(allMeshes);

        // Build CoordinateInfo correctly for server-shifted meshes:
        // - shiftedBounds = bounds (already shifted by server)
        // - originalBounds = bounds + originShift (reconstruct original world coordinates)
        const serverCoordInfo = result.metadata.coordinate_info;
        // (Y-up like the meshes: the server leaves the shift in IFC Z-up.)
        const originShift = serverOriginShift(serverCoordInfo?.origin_shift);

        // When server already shifted meshes, shiftedBounds IS the calculated bounds
        // (don't use createCoordinateInfo which would subtract originShift again)
        const coordinateInfo: CoordinateInfo = {
          originShift,
          // Original bounds = shifted bounds + originShift (reconstruct world coordinates)
          originalBounds: {
            min: {
              x: bounds.min.x + originShift.x,
              y: bounds.min.y + originShift.y,
              z: bounds.min.z + originShift.z,
            },
            max: {
              x: bounds.max.x + originShift.x,
              y: bounds.max.y + originShift.y,
              z: bounds.max.z + originShift.z,
            },
          },
          // Shifted bounds = bounds as-is (server already applied shift)
          shiftedBounds: {
            min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
            max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
          },
          // Note: server returns is_geo_referenced but it really means "had large coordinates"
          hasLargeCoordinates: serverCoordInfo?.is_geo_referenced ?? false,
        };

        // Set all geometry at once
        setProgress({ phase: 'Rendering geometry', percent: 80 });
        setGeometryResult({
          meshes: allMeshes,
          totalVertices: result.stats.total_vertices,
          totalTriangles: result.stats.total_triangles,
          coordinateInfo,
        });
      }

      if (isStale?.() || signal?.aborted) return false;
      // Model-owned hydration outlives this load's finally and metadata signal.
      hydrateProperties(modelId, isStale, async propertySignal => {
        const included = 'data_model' in result ? result.data_model : null;
        const dataModelBuffer = included?.byteLength ? included : await client.fetchDataModel(result.cache_key, { signal: propertySignal });
        if (!dataModelBuffer) return null;
        const dataModel = await decodeDataModel(dataModelBuffer);
        return convertServerDataModel(dataModel, result as ServerParseResult, { size: openedBytes }, allMeshes);
      });
      setProgress({ phase: 'Complete', percent: 100 });
      return true;
    } catch (err) {
      if (processed) throw err; // a processed model's failure shows in its card
      console.error('[useIfc] Server parse failed:', err);
      return false;
    }
  }, [hydrateProperties, cancelProperties]);

  return { loadFromServer };
}

export default useIfcServer;
