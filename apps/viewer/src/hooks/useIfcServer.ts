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
import { useViewerStore } from '../store/index.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import {
  IfcServerClient,
  decodeDataModel,
  type ParquetBatch,
  type DataModel,
  type ParquetParseResponse,
  type ParquetStreamResult,
  type ParseResponse,
  type ModelMetadata,
  type ProcessingStats,
  type MeshData as ServerMeshData,
} from '@ifc-lite/server-client';

import { SERVER_URL } from '../utils/ifcConfig.js';
import {
  createEmptyBounds,
  updateBoundsFromPositions,
  calculateMeshBounds,
  createCoordinateInfo,
  getServerStreamIntervalMs,
} from '../utils/localParsingUtils.js';

// Server data model conversion
import { convertServerDataModel, type ServerParseResult } from '../utils/serverDataModel.js';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';

/** Convert server mesh data (snake_case) to viewer format (camelCase) */
function convertServerMesh(m: ServerMeshData): MeshData {
  return {
    expressId: m.express_id,
    positions: new Float32Array(m.positions),
    indices: new Uint32Array(m.indices),
    normals: m.normals ? new Float32Array(m.normals) : new Float32Array(0),
    color: m.color,
    ifcType: m.ifc_type,
  };
}

/** Server parse result type - union of streaming and non-streaming responses */
type ServerParseResultType = ParquetParseResponse | ParquetStreamResult | ParseResponse;

// Module-level server availability cache - avoids repeated failed connection attempts
let serverAvailabilityCache: { available: boolean; checkedAt: number } | null = null;
const SERVER_CHECK_CACHE_MS = 30000; // Re-check server availability every 30 seconds

/**
 * Check if server URL is reachable from current origin
 * Returns false immediately if localhost server from non-localhost origin (would cause CORS)
 */
function isServerReachable(serverUrl: string): boolean {
  try {
    const server = new URL(serverUrl);
    const isServerLocalhost = server.hostname === 'localhost' || server.hostname === '127.0.0.1';

    // In browser, check if we're on localhost
    if (typeof window !== 'undefined') {
      const isClientLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

      // Skip localhost server when running from remote origin (avoids CORS error in console)
      if (isServerLocalhost && !isClientLocalhost) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Silently check if server is available (no console logging on failure)
 * Returns cached result if recently checked
 */
async function isServerAvailable(serverUrl: string, client: IfcServerClient): Promise<boolean> {
  // First check if server is even reachable (prevents CORS errors)
  if (!isServerReachable(serverUrl)) {
    return false;
  }

  const now = Date.now();

  // Use cached result if recent
  if (serverAvailabilityCache && (now - serverAvailabilityCache.checkedAt) < SERVER_CHECK_CACHE_MS) {
    return serverAvailabilityCache.available;
  }

  // Perform silent health check
  try {
    await client.health();
    serverAvailabilityCache = { available: true, checkedAt: now };
    return true;
  } catch {
    // Silent failure - don't log network errors for unavailable server
    serverAvailabilityCache = { available: false, checkedAt: now };
    return false;
  }
}

/**
 * Hook for server-side IFC file parsing
 * Handles server reachability, streaming/Parquet/JSON parsing paths,
 * and ServerClient lifecycle
 */
export function useIfcServer() {
  /**
   * Load from server - uses server-side PARALLEL parsing for maximum speed
   * Uses full parse endpoint (not streaming) for all-at-once parallel processing
   *
   * Store actions are retrieved via getState() inside the callback to avoid
   * subscribing the hook to the entire store (which would cause unnecessary re-renders).
   */
  const loadFromServer = useCallback(async (
    file: File,
    buffer: ArrayBuffer,
    /** Optional staleness check — returns true if this load has been superseded. */
    isStale?: () => boolean,
  ): Promise<boolean> => {
    const { setProgress, setIfcDataStore, setGeometryResult } = useViewerStore.getState();
    try {
      setProgress({ phase: 'Connecting to server', percent: 5 });

      const client = new IfcServerClient({ baseUrl: SERVER_URL });

      // Silent server availability check (cached, no error logging)
      const serverAvailable = await isServerAvailable(SERVER_URL, client);
      if (!serverAvailable) {
        return false; // Silently fall back - caller handles logging
      }

      if (isStale?.()) return false;
      setProgress({ phase: 'Processing on server (parallel)', percent: 15 });

      // Check if Parquet is supported (requires parquet-wasm)
      const parquetSupported = await client.isParquetSupported();

      let allMeshes: MeshData[];
      let result: ServerParseResultType;

      // Use streaming for large files (>150MB) for progressive rendering
      // Smaller files use non-streaming path (faster - avoids ~1.1s background re-processing overhead)
      // Streaming overhead: ~67 batch serializations + background re-processing (~1100ms)
      // Non-streaming: single serialization (~218ms for 60k meshes)
      // Threshold chosen to balance UX (progressive rendering) vs performance (overhead)
      const fileSizeMB = buffer.byteLength / (1024 * 1024);
      const USE_STREAMING_THRESHOLD_MB = 150;

      if (parquetSupported && fileSizeMB > USE_STREAMING_THRESHOLD_MB) {
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
        const SERVER_STREAM_INTERVAL_MS = getServerStreamIntervalMs(fileSizeMB);

        // Use streaming endpoint with batch callback
        const streamResult = await client.parseParquetStream(file, (batch: ParquetBatch) => {
          batchCount++;

          // Convert batch meshes to viewer format (snake_case to camelCase, number[] to TypedArray)
          const batchMeshes: MeshData[] = batch.meshes.map(convertServerMesh);

          // Update bounds incrementally
          for (const mesh of batchMeshes) {
            updateBoundsFromPositions(bounds, mesh.positions);
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
        const originShift = streamMetadata?.coordinate_info?.origin_shift
          ? { x: streamMetadata.coordinate_info.origin_shift[0], y: streamMetadata.coordinate_info.origin_shift[1], z: streamMetadata.coordinate_info.origin_shift[2] }
          : { x: 0, y: 0, z: 0 };
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
        result = parquetResult;

        setProgress({ phase: 'Converting meshes', percent: 70 });

        // Convert server mesh format to viewer format (TypedArrays)
        allMeshes = parquetResult.meshes.map(convertServerMesh);
      } else {
        // Fallback to JSON endpoint
        result = await client.parse(file);

        setProgress({ phase: 'Converting meshes', percent: 70 });

        // Convert server mesh format to viewer format
        const jsonResult = result as ParseResponse;
        allMeshes = jsonResult.meshes.map(convertServerMesh);
      }

      // For non-streaming paths, calculate bounds and set geometry
      // (Streaming path already handled this progressively)
      const wasStreaming = parquetSupported && fileSizeMB > USE_STREAMING_THRESHOLD_MB;

      if (!wasStreaming) {
        // Calculate bounds from mesh positions for camera fitting
        // IMPORTANT: Server already applies RTC shift to mesh positions, so bounds calculated
        // from mesh positions are ALREADY in shifted coordinates (small values near origin).
        // We must NOT subtract originShift again - that would give huge negative bounds!
        const { bounds } = calculateMeshBounds(allMeshes);

        // Build CoordinateInfo correctly for server-shifted meshes:
        // - shiftedBounds = bounds (already shifted by server)
        // - originalBounds = bounds + originShift (reconstruct original world coordinates)
        const serverCoordInfo = result.metadata.coordinate_info;
        const originShift = serverCoordInfo?.origin_shift
          ? { x: serverCoordInfo.origin_shift[0], y: serverCoordInfo.origin_shift[1], z: serverCoordInfo.origin_shift[2] }
          : { x: 0, y: 0, z: 0 };

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

      // Fetch and decode data model asynchronously (geometry already displayed)
      // Data model is processed on server in background, fetch via separate endpoint
      const cacheKey = result.cache_key;

      // Start data model fetch in background - don't block rendering
      (async () => {
        if (isStale?.()) return;
        setProgress({ phase: 'Fetching data model', percent: 85 });
        try {
          // If data model was included in response (ParquetParseResponse), use it directly
          // Otherwise, fetch from the data model endpoint
          let dataModelBuffer: ArrayBuffer | null = null;
          if ('data_model' in result && result.data_model) {
            dataModelBuffer = result.data_model;
          }

          if (!dataModelBuffer || dataModelBuffer.byteLength === 0) {
            dataModelBuffer = await client.fetchDataModel(cacheKey);
          }

          if (!dataModelBuffer) {
            return;
          }

          const dataModel: DataModel = await decodeDataModel(dataModelBuffer);

          // Convert server data model directly to IfcDataStore format
          const dataStore = convertServerDataModel(
            dataModel,
            result as ServerParseResult,
            file,
            allMeshes
          );

          if (isStale?.()) return;
          setIfcDataStore(dataStore);

          buildSpatialIndexGuarded(allMeshes, dataStore, setIfcDataStore);
        } catch (err) {
          if (!isStale?.()) {
            console.warn('[useIfc] Server data model fetch/decode failed; geometry shown without properties:', err);
          }
        }
      })(); // End of async data model fetch block - runs in background, doesn't block

      // Geometry is ready - mark complete immediately (data model loads in background)
      setProgress({ phase: 'Complete', percent: 100 });
      return true;
    } catch (err) {
      console.error('[useIfc] Server parse failed:', err);
      return false;
    }
  }, []);

  return { loadFromServer };
}

export default useIfcServer;
