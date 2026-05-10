/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/geometry - Geometry processing bridge
 * Now powered by IFC-Lite native Rust WASM (1.9x faster than web-ifc)
 */

// IFC-Lite components (recommended - faster)
export { IfcLiteBridge, type SymbolicRepresentationCollection, type SymbolicPolyline, type SymbolicCircle, type ProfileCollection, type ProfileEntryJs } from './ifc-lite-bridge.js';
export { IfcLiteMeshCollector, type StreamingColorUpdateEvent, type StreamingRtcOffsetEvent } from './ifc-lite-mesh-collector.js';
import type { StreamingColorUpdateEvent, StreamingRtcOffsetEvent } from './ifc-lite-mesh-collector.js';

// Platform bridge abstraction (auto-selects WASM or native based on environment)
export {
  createPlatformBridge,
  isTauri,
  type IPlatformBridge,
  type GeometryProcessingResult,
  type GeometryStats as PlatformGeometryStats,
  type StreamingOptions,
  type StreamingProgress,
  type GeometryBatch,
  type MetadataBootstrapPayload,
  type MetadataBootstrapEntitySummary,
  type MetadataBootstrapSpatialNode,
} from './platform-bridge.js';

// Support components
export { BufferBuilder } from './buffer-builder.js';
export { CoordinateHandler } from './coordinate-handler.js';
export { GeometryQuality } from './progressive-loader.js';

export { LODGenerator, type LODConfig, type LODMesh } from './lod.js';
export {
  deduplicateMeshes,
  getDeduplicationStats,
  type InstancedMeshData,
  type DeduplicationStats
} from './geometry-deduplicator.js';
export * from './types.js';
export * from './default-materials.js';

// Zero-copy GPU upload (new - faster, less memory)
export { WasmMemoryManager, type GpuGeometryHandle, type GpuMeshMetadataHandle, type GpuInstancedGeometryHandle, type GpuInstancedGeometryCollectionHandle, type GpuInstancedGeometryRefHandle } from './wasm-memory-manager.js';
export {
  ZeroCopyMeshCollector,
  ZeroCopyInstancedCollector,
  type ZeroCopyStreamingProgress,
  type ZeroCopyBatchResult,
  type ZeroCopyCompleteStats,
  type ZeroCopyMeshMetadata,
  type ZeroCopyBatch,
  type ZeroCopyInstancedBatch,
} from './zero-copy-collector.js';

// Legacy exports for compatibility (deprecated)
export { IfcLiteBridge as WebIfcBridge } from './ifc-lite-bridge.js';

import { IfcLiteBridge } from './ifc-lite-bridge.js';
import { IfcLiteMeshCollector } from './ifc-lite-mesh-collector.js';
import { BufferBuilder } from './buffer-builder.js';
import { CoordinateHandler } from './coordinate-handler.js';
import { GeometryQuality } from './progressive-loader.js';
import { createPlatformBridge, isTauri, type GeometryStats as PlatformGeometryStats, type IPlatformBridge } from './platform-bridge.js';
import type { GeometryResult, MeshData, CoordinateInfo } from './types.js';

// Extracted sub-modules
import { getStreamingBatchSize, convertMeshCollectionToBatch, convertInstancedCollectionToBatch, withBuildingRotation } from './geometry-coordinate.js';
import { streamNativeGeometry, type QueuedNativeStreamingEvent } from './geometry-native.js';
import { processParallel } from './geometry-parallel.js';

interface ByteStreamingPrePassResult {
  jobs: Uint32Array;
  totalJobs: number;
  unitScale: number;
  rtcOffset?: Float64Array;
  needsShift: boolean;
  buildingRotation?: number | null;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
}

export interface GeometryProcessorOptions {
  quality?: GeometryQuality; // Default: Balanced
  preferNative?: boolean; // Default: true in Tauri
}

/**
 * Dynamic batch configuration for ramp-up streaming
 * Starts with small batches for fast first frame, ramps up for throughput
 */
export interface DynamicBatchConfig {
  /** Initial batch size for first 3 batches (default: 50) */
  initialBatchSize?: number;
  /** Maximum batch size for batches 11+ (default: 500) */
  maxBatchSize?: number;
  /** File size in MB for adaptive sizing (optional) */
  fileSizeMB?: number;
}

/**
 * Calculate dynamic batch size based on batch number
 */
export function calculateDynamicBatchSize(
  batchNumber: number,
  initialBatchSize: number = 50,
  maxBatchSize: number = 500
): number {
  if (batchNumber <= 3) {
    return initialBatchSize; // Fast first frame
  } else if (batchNumber <= 6) {
    return Math.floor((initialBatchSize + maxBatchSize) / 2); // Quick ramp
  } else {
    return maxBatchSize; // Full throughput earlier
  }
}

export type StreamingGeometryEvent =
  | { type: 'start'; totalEstimate: number }
  | { type: 'model-open'; modelID: number }
  | {
      type: 'batch';
      meshes: MeshData[];
      totalSoFar: number;
      coordinateInfo?: import('./types.js').CoordinateInfo;
      nativeTelemetry?: import('./platform-bridge.js').NativeBatchTelemetry;
    }
  | { type: 'colorUpdate'; updates: Map<number, [number, number, number, number]> }
  | { type: 'rtcOffset'; rtcOffset: { x: number; y: number; z: number }; hasRtc: boolean }
  | {
      /**
       * Per-worker memory snapshot, emitted once per geometry worker once
       * it has finished processing. Aggregated by the viewer's
       * `memoryAccounting` module to surface total WASM heap and mesh
       * byte counts across all parallel workers.
       */
      type: 'workerMemory';
      workerIndex: number;
      wasmHeapBytes: number;
      meshBytes: number;
    }
  | { type: 'complete'; totalMeshes: number; coordinateInfo: import('./types.js').CoordinateInfo };

export type StreamingInstancedGeometryEvent =
  | { type: 'start'; totalEstimate: number }
  | { type: 'model-open'; modelID: number }
  | { type: 'batch'; geometries: import('@ifc-lite/wasm').InstancedGeometry[]; totalSoFar: number; coordinateInfo?: import('./types.js').CoordinateInfo }
  | { type: 'complete'; totalGeometries: number; totalInstances: number; coordinateInfo: import('./types.js').CoordinateInfo };

// QueuedNativeStreamingEvent, native stream constants, and yieldToEventLoop
// have been extracted to ./geometry-native.ts

export class GeometryProcessor {
  private static largeFileByteStreamingThreshold = 256 * 1024 * 1024;

  private bridge: IfcLiteBridge | null = null;
  private platformBridge: IPlatformBridge | null = null;
  private bufferBuilder: BufferBuilder;
  private coordinateHandler: CoordinateHandler;
  private isNative: boolean = false;
  private lastNativeStats: PlatformGeometryStats | null = null;

  constructor(options: GeometryProcessorOptions = {}) {
    this.bufferBuilder = new BufferBuilder();
    this.coordinateHandler = new CoordinateHandler();
    this.isNative = options.preferNative !== false && isTauri();
    // Note: options accepted for API compatibility
    void options.quality;

    if (!this.isNative) {
      this.bridge = new IfcLiteBridge();
    }
  }

  /**
   * Initialize the geometry processor
   * In Tauri: Creates platform bridge for native Rust processing
   * In browser: Loads WASM
   */
  async init(): Promise<void> {
    if (this.isNative) {
      // Create platform bridge for native processing
      this.platformBridge = await createPlatformBridge();
      await this.platformBridge.init();
      console.log('[GeometryProcessor] Native bridge initialized');
    } else {
      // WASM path
      if (this.bridge) {
        await this.bridge.init();
      }
    }
  }

  /**
   * Process IFC file and extract geometry (synchronous, use processStreaming for large files)
   * @param buffer IFC file buffer
   * @param entityIndex Optional entity index for priority-based loading
   */
  async process(buffer: Uint8Array, entityIndex?: Map<number, any>): Promise<GeometryResult> {
    void entityIndex;

    let meshes: MeshData[];

    if (this.isNative && this.platformBridge) {
      // NATIVE PATH - Use Tauri commands
      console.time('[GeometryProcessor] native-processing');
      const result = await this.platformBridge.processGeometry(buffer);
      meshes = result.meshes;
      console.timeEnd('[GeometryProcessor] native-processing');
    } else {
      // WASM PATH - Synchronous processing on main thread
      // For large files, use processStreaming() instead
      if (!this.bridge?.isInitialized()) {
        await this.init();
      }
      const mainThreadResult = await this.collectMeshesMainThread(buffer);
      meshes = mainThreadResult.meshes;
      // Merge building rotation from WASM into coordinate info
      const coordinateInfoFromHandler = this.coordinateHandler.processMeshes(meshes);
      const buildingRotation = mainThreadResult.buildingRotation;
      const coordinateInfo: CoordinateInfo = {
        ...coordinateInfoFromHandler,
        buildingRotation,
      };
      // Build GPU-ready buffers
      const bufferResult = this.bufferBuilder.processMeshes(meshes);

      // Combine results
      return {
        meshes: bufferResult.meshes,
        totalTriangles: bufferResult.totalTriangles,
        totalVertices: bufferResult.totalVertices,
        coordinateInfo,
      };
    }

    // Handle large coordinates by shifting to origin
    const coordinateInfo = this.coordinateHandler.processMeshes(meshes);

    // Build GPU-ready buffers
    const bufferResult = this.bufferBuilder.processMeshes(meshes);

    // Combine results
    const result: GeometryResult = {
      meshes: bufferResult.meshes,
      totalTriangles: bufferResult.totalTriangles,
      totalVertices: bufferResult.totalVertices,
      coordinateInfo,
    };

    return result;
  }

  /**
   * Process IFC geometry directly from a filesystem path in native desktop
   * hosts. This avoids copying IFC content through JS when the host already
   * has the file path.
   */
  async processPath(path: string): Promise<GeometryResult> {
    if (!this.isNative) {
      throw new Error('Path-based geometry processing is only available in native desktop builds');
    }
    if (!this.platformBridge) {
      await this.init();
    }
    if (!this.platformBridge?.processGeometryPath) {
      throw new Error('Native platform bridge does not support file-path geometry processing');
    }

    const result = await this.platformBridge.processGeometryPath(path);
    const coordinateInfo = this.coordinateHandler.processMeshes(result.meshes);

    return {
      meshes: result.meshes,
      totalTriangles: result.totalTriangles,
      totalVertices: result.totalVertices,
      coordinateInfo,
    };
  }

  /**
   * Collect meshes on main thread using IFC-Lite WASM
   */
  private async collectMeshesMainThread(buffer: Uint8Array, _entityIndex?: Map<number, any>): Promise<{ meshes: MeshData[]; buildingRotation?: number }> {
    if (!this.bridge) {
      throw new Error('WASM bridge not initialized');
    }

    // Convert buffer to string (IFC files are text)
    const decoder = new TextDecoder();
    const content = decoder.decode(buffer);

    const collector = new IfcLiteMeshCollector(this.bridge.getApi(), content);
    const meshes = collector.collectMeshes();
    const buildingRotation = collector.getBuildingRotation();

    return { meshes, buildingRotation };
  }

  // getStreamingBatchSize, convertMeshCollectionToBatch,
  // convertInstancedCollectionToBatch, and withBuildingRotation have been
  // extracted to ./geometry-coordinate.ts and are used as free functions.

  private async *processStreamingBytes(
    buffer: Uint8Array,
    batchConfig: number | DynamicBatchConfig
  ): AsyncGenerator<StreamingGeometryEvent> {
    if (!this.bridge) {
      throw new Error('WASM bridge not initialized');
    }

    const api = this.bridge.getApi();
    const prePass = api.buildPrePassOnce(buffer) as ByteStreamingPrePassResult;

    yield { type: 'model-open', modelID: 0 };

    if (prePass.rtcOffset) {
      yield {
        type: 'rtcOffset',
        rtcOffset: {
          x: prePass.rtcOffset[0] ?? 0,
          y: prePass.rtcOffset[1] ?? 0,
          z: prePass.rtcOffset[2] ?? 0,
        },
        hasRtc: Boolean(prePass.needsShift),
      };
    }

    const buildingRotation = prePass.buildingRotation ?? undefined;
    if (!prePass.jobs || prePass.totalJobs === 0) {
      const coordinateInfo = withBuildingRotation(
        this.coordinateHandler.getFinalCoordinateInfo(),
        buildingRotation,
      );
      yield { type: 'complete', totalMeshes: 0, coordinateInfo };
      return;
    }

    const batchSize = getStreamingBatchSize(buffer, batchConfig);
    // Cap at ~30 batches max to avoid excessive per-batch overhead
    const maxBatches = 30;
    const effectiveBatchSize = Math.max(batchSize, Math.ceil(prePass.totalJobs / maxBatches));
    let totalMeshes = 0;

    for (let startJob = 0; startJob < prePass.totalJobs; startJob += effectiveBatchSize) {
      const endJob = Math.min(startJob + effectiveBatchSize, prePass.totalJobs);
      const jobSlice = prePass.jobs.slice(startJob * 3, endJob * 3);
      const collection = api.processGeometryBatch(
        buffer,
        jobSlice,
        prePass.unitScale,
        prePass.rtcOffset?.[0] ?? 0,
        prePass.rtcOffset?.[1] ?? 0,
        prePass.rtcOffset?.[2] ?? 0,
        prePass.needsShift,
        prePass.voidKeys,
        prePass.voidCounts,
        prePass.voidValues,
        prePass.styleIds,
        prePass.styleColors,
      );

      const batch = convertMeshCollectionToBatch(collection);
      if (batch.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        continue;
      }

      this.coordinateHandler.processMeshesIncremental(batch);
      totalMeshes += batch.length;
      const currentCoordinateInfo = this.coordinateHandler.getCurrentCoordinateInfo();
      const coordinateInfo = currentCoordinateInfo
        ? withBuildingRotation(currentCoordinateInfo, buildingRotation)
        : null;

      yield {
        type: 'batch',
        meshes: batch,
        totalSoFar: totalMeshes,
        coordinateInfo: coordinateInfo || undefined,
      };

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    api.clearPrePassCache?.();

    const coordinateInfo = withBuildingRotation(
      this.coordinateHandler.getFinalCoordinateInfo(),
      buildingRotation,
    );
    yield { type: 'complete', totalMeshes, coordinateInfo };
  }

  private async *processInstancedStreamingBytes(
    buffer: Uint8Array,
    batchSize: number
  ): AsyncGenerator<StreamingInstancedGeometryEvent> {
    if (!this.bridge) {
      throw new Error('WASM bridge not initialized');
    }

    const api = this.bridge.getApi();
    const prePass = api.buildPrePassOnce(buffer) as ByteStreamingPrePassResult;
    const buildingRotation = prePass.buildingRotation ?? undefined;

    yield { type: 'model-open', modelID: 0 };

    if (!prePass.jobs || prePass.totalJobs === 0) {
      const coordinateInfo = withBuildingRotation(
        this.coordinateHandler.getFinalCoordinateInfo(),
        buildingRotation,
      );
      yield { type: 'complete', totalGeometries: 0, totalInstances: 0, coordinateInfo };
      return;
    }

    let totalGeometries = 0;
    let totalInstances = 0;

    // Cap at ~30 batches max to avoid excessive per-batch overhead
    const maxBatches = 30;
    const effectiveBatchSize = Math.max(batchSize, Math.ceil(prePass.totalJobs / maxBatches));

    for (let startJob = 0; startJob < prePass.totalJobs; startJob += effectiveBatchSize) {
      const endJob = Math.min(startJob + effectiveBatchSize, prePass.totalJobs);
      const jobSlice = prePass.jobs.slice(startJob * 3, endJob * 3);
      const collection = api.processInstancedGeometryBatch(
        buffer,
        jobSlice,
        prePass.unitScale,
        prePass.rtcOffset?.[0] ?? 0,
        prePass.rtcOffset?.[1] ?? 0,
        prePass.rtcOffset?.[2] ?? 0,
        prePass.needsShift,
        prePass.styleIds,
        prePass.styleColors,
      );

      const batch = convertInstancedCollectionToBatch(collection);
      if (batch.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        continue;
      }

      const meshDataBatch: MeshData[] = [];
      for (const geom of batch) {
        const positions = geom.positions;
        const normals = geom.normals;
        const indices = geom.indices;

        if (geom.instance_count > 0) {
          const firstInstance = geom.get_instance(0);
          if (firstInstance) {
            const color = firstInstance.color;
            meshDataBatch.push({
              expressId: firstInstance.expressId,
              positions,
              normals,
              indices,
              color: [color[0], color[1], color[2], color[3]],
            });
          }
        }
      }

      if (meshDataBatch.length > 0) {
        this.coordinateHandler.processMeshesIncremental(meshDataBatch);
      }

      totalGeometries += batch.length;
      totalInstances += batch.reduce((sum, geometry) => sum + geometry.instance_count, 0);
      const currentCoordinateInfo = this.coordinateHandler.getCurrentCoordinateInfo();
      const coordinateInfo = currentCoordinateInfo
        ? withBuildingRotation(currentCoordinateInfo, buildingRotation)
        : null;

      yield {
        type: 'batch',
        geometries: batch,
        totalSoFar: totalGeometries,
        coordinateInfo: coordinateInfo || undefined,
      };

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    api.clearPrePassCache?.();

    const coordinateInfo = withBuildingRotation(
      this.coordinateHandler.getFinalCoordinateInfo(),
      buildingRotation,
    );
    yield { type: 'complete', totalGeometries, totalInstances, coordinateInfo };
  }

  /**
   * Process IFC file with streaming output for progressive rendering
   * Uses native Rust in Tauri, WASM in browser
   * @param buffer IFC file buffer
   * @param entityIndex Optional entity index for priority-based loading
   * @param batchConfig Dynamic batch configuration or fixed batch size
   */
  async *processStreaming(
    buffer: Uint8Array,
    _entityIndex?: Map<number, any>,
    batchConfig: number | DynamicBatchConfig = 25,
    // TODO: sharedRtcOffset is accepted but not yet threaded through to the
    // WASM streaming collector. The WASM layer detects its own RTC offset
    // per-model; federation-level override requires collector API changes.
    sharedRtcOffset?: { x: number; y: number; z: number },
  ): AsyncGenerator<StreamingGeometryEvent> {
    // Initialize if needed
    if (this.isNative) {
      if (!this.platformBridge) {
        await this.init();
      }
    } else if (!this.bridge?.isInitialized()) {
      await this.init();
    }

    // Reset coordinate handler for new file
    this.coordinateHandler.reset();

    // Yield start event FIRST so UI can update before heavy processing
    yield { type: 'start', totalEstimate: buffer.length / 1000 };

    // Yield to main thread before heavy processing begins
    await new Promise(resolve => setTimeout(resolve, 0));

    if (this.isNative && this.platformBridge) {
      yield { type: 'model-open', modelID: 0 };

      // NATIVE PATH - Use Tauri streaming (simpler queue without coalescing)
      console.time('[GeometryProcessor] native-streaming');
      const queuedEvents: QueuedNativeStreamingEvent[] = [];
      let resolvePending: (() => void) | null = null;
      let completed = false;
      let streamError: Error | null = null;
      let completedTotalMeshes: number | undefined;
      let totalMeshes = 0;

      const wake = () => {
        if (resolvePending) {
          resolvePending();
          resolvePending = null;
        }
      };

      const streamingPromise = this.platformBridge.processGeometryStreaming(buffer, {
        onBatch: (batch) => {
          queuedEvents.push({ type: 'batch', meshes: batch.meshes, nativeTelemetry: batch.nativeTelemetry });
          wake();
        },
        onColorUpdate: (updates) => {
          queuedEvents.push({ type: 'colorUpdate', updates: new Map(updates) });
          wake();
        },
        onComplete: (stats) => {
          this.lastNativeStats = stats;
          completedTotalMeshes = stats.totalMeshes;
          completed = true;
          wake();
        },
        onError: (error) => {
          streamError = error;
          completed = true;
          wake();
        },
      });

      while (!completed || queuedEvents.length > 0) {
        while (queuedEvents.length > 0) {
          const event = queuedEvents.shift()!;
          if (event.type === 'colorUpdate') {
            yield { type: 'colorUpdate', updates: event.updates };
            continue;
          }
          this.coordinateHandler.processMeshesIncremental(event.meshes);
          totalMeshes += event.meshes.length;
          const coordinateInfo = this.coordinateHandler.getCurrentCoordinateInfo();
          yield {
            type: 'batch',
            meshes: event.meshes,
            totalSoFar: totalMeshes,
            coordinateInfo: coordinateInfo || undefined,
            nativeTelemetry: event.nativeTelemetry,
          };
        }

        if (streamError) {
          throw streamError;
        }

        if (!completed) {
          await new Promise<void>((resolve) => {
            resolvePending = resolve;
          });
        }
      }

      await streamingPromise;

      const coordinateInfo = this.coordinateHandler.getFinalCoordinateInfo();
      yield { type: 'complete', totalMeshes: completedTotalMeshes ?? totalMeshes, coordinateInfo };

      console.timeEnd('[GeometryProcessor] native-streaming');
    } else {
      // WASM PATH
      if (!this.bridge) {
        throw new Error('WASM bridge not initialized');
      }

      if (buffer.length >= GeometryProcessor.largeFileByteStreamingThreshold) {
        yield* this.processStreamingBytes(buffer, batchConfig);
        return;
      }

      // Convert buffer to string (IFC files are text)
      const decoder = new TextDecoder();
      const content = decoder.decode(buffer);

      yield { type: 'model-open', modelID: 0 };

      const collector = new IfcLiteMeshCollector(this.bridge.getApi(), content);
      let totalMeshes = 0;
      let extractedBuildingRotation: number | undefined = undefined;

      const wasmBatchSize = getStreamingBatchSize(buffer, batchConfig);

      // Use WASM batches directly for maximum throughput
      for await (const item of collector.collectMeshesStreaming(wasmBatchSize)) {
        // Handle color update events
        if (item && typeof item === 'object' && 'type' in item && (item as StreamingColorUpdateEvent).type === 'colorUpdate') {
          yield { type: 'colorUpdate', updates: (item as StreamingColorUpdateEvent).updates };
          continue;
        }

        // Handle RTC offset events
        if (item && typeof item === 'object' && 'type' in item && (item as StreamingRtcOffsetEvent).type === 'rtcOffset') {
          const rtcEvent = item as StreamingRtcOffsetEvent;
          yield { type: 'rtcOffset', rtcOffset: rtcEvent.rtcOffset, hasRtc: rtcEvent.hasRtc };
          continue;
        }

        // Handle mesh batches
        const batch = item as MeshData[];
        // Process coordinate shifts incrementally (will accumulate bounds)
        this.coordinateHandler.processMeshesIncremental(batch);
        totalMeshes += batch.length;
        const coordinateInfo = this.coordinateHandler.getCurrentCoordinateInfo();

        // Merge buildingRotation if we have it
        const coordinateInfoWithRotation = coordinateInfo && extractedBuildingRotation !== undefined
          ? { ...coordinateInfo, buildingRotation: extractedBuildingRotation }
          : coordinateInfo;

        yield { type: 'batch', meshes: batch, totalSoFar: totalMeshes, coordinateInfo: coordinateInfoWithRotation || undefined };
      }

      // Get building rotation after streaming completes
      extractedBuildingRotation = collector.getBuildingRotation();

      const coordinateInfo = this.coordinateHandler.getFinalCoordinateInfo();
      const finalCoordinateInfo = extractedBuildingRotation !== undefined
        ? { ...coordinateInfo, buildingRotation: extractedBuildingRotation }
        : coordinateInfo;
      yield { type: 'complete', totalMeshes, coordinateInfo: finalCoordinateInfo };
    }
  }

  /**
   * Stream geometry directly from a filesystem path in native desktop hosts.
   * This avoids copying very large IFC files through JS and Tauri IPC.
   */
  async *processStreamingPath(
    path: string,
    estimatedBytes: number = 0,
    cacheKey?: string,
  ): AsyncGenerator<StreamingGeometryEvent> {
    if (!this.isNative) {
      throw new Error('File-path geometry streaming is only available in native desktop builds');
    }
    if (!this.platformBridge) {
      await this.init();
    }
    if (!this.platformBridge?.processGeometryStreamingPath) {
      throw new Error('Native platform bridge does not support file-path streaming');
    }

    yield* streamNativeGeometry(
      (options) => this.platformBridge!.processGeometryStreamingPath!(path, options, cacheKey),
      estimatedBytes > 0 ? estimatedBytes / 1000 : 0,
      this.coordinateHandler,
      (stats) => { this.lastNativeStats = stats; },
    );
  }

  async *processStreamingCache(
    cacheKey: string
  ): AsyncGenerator<StreamingGeometryEvent> {
    if (!this.isNative) {
      throw new Error('Native cached geometry streaming is only available in native desktop builds');
    }
    if (!this.platformBridge) {
      await this.init();
    }
    if (!this.platformBridge?.processGeometryStreamingCache) {
      throw new Error('Native platform bridge does not support cached geometry streaming');
    }

    yield* streamNativeGeometry(
      (options) => this.platformBridge!.processGeometryStreamingCache!(cacheKey, options),
      0,
      this.coordinateHandler,
      (stats) => { this.lastNativeStats = stats; },
    );
  }

  /**
   * Process IFC file with streaming instanced geometry output for progressive rendering
   * Groups identical geometries by hash (before transformation) for GPU instancing
   * @param buffer IFC file buffer
   * @param batchSize Number of unique geometries per batch (default: 25)
   */
  async *processInstancedStreaming(
    buffer: Uint8Array,
    batchSize: number = 25
  ): AsyncGenerator<StreamingInstancedGeometryEvent> {
    // Initialize if needed
    if (this.isNative) {
      if (!this.platformBridge) {
        await this.init();
      }
      // Note: Native instanced streaming not yet implemented - fall through to WASM
      // For now, throw an error to make it clear
      console.warn('[GeometryProcessor] Native instanced streaming not yet implemented, using WASM');
    }

    if (!this.bridge?.isInitialized()) {
      await this.init();
    }

    // Reset coordinate handler for new file
    this.coordinateHandler.reset();

    yield { type: 'start', totalEstimate: buffer.length / 1000 };

    // Adapt batch size for large files to reduce callback overhead
    // Larger batches = fewer callbacks = less overhead for huge models
    const fileSizeMB = buffer.length / (1024 * 1024);
    const effectiveBatchSize = fileSizeMB < 50 ? batchSize : fileSizeMB < 200 ? Math.max(batchSize, 50) : fileSizeMB < 300 ? Math.max(batchSize, 100) : Math.max(batchSize, 200);
    const byteBatchSize = Math.max(effectiveBatchSize, getStreamingBatchSize(buffer, batchSize));

    if (buffer.length >= GeometryProcessor.largeFileByteStreamingThreshold) {
      yield* this.processInstancedStreamingBytes(buffer, byteBatchSize);
      return;
    }

    // Convert buffer to string (IFC files are text)
    const decoder = new TextDecoder();
    const content = decoder.decode(buffer);

    // Use a placeholder model ID (IFC-Lite doesn't use model IDs)
    yield { type: 'model-open', modelID: 0 };

    const collector = new IfcLiteMeshCollector(this.bridge!.getApi(), content);
    let totalGeometries = 0;
    let totalInstances = 0;

    for await (const batch of collector.collectInstancedGeometryStreaming(effectiveBatchSize)) {
      // For instanced geometry, we need to extract mesh data from instances for coordinate handling
      // Convert InstancedGeometry to MeshData[] for coordinate handler
      const meshDataBatch: MeshData[] = [];
      for (const geom of batch) {
        const positions = geom.positions;
        const normals = geom.normals;
        const indices = geom.indices;

        // Create a mesh data entry for each instance (for coordinate bounds calculation)
        // We'll use the first instance's color as representative
        if (geom.instance_count > 0) {
          const firstInstance = geom.get_instance(0);
          if (firstInstance) {
            const color = firstInstance.color;
            meshDataBatch.push({
              expressId: firstInstance.expressId,
              positions,
              normals,
              indices,
              color: [color[0], color[1], color[2], color[3]],
            });
          }
        }
      }

      // Process coordinate shifts incrementally
      if (meshDataBatch.length > 0) {
        this.coordinateHandler.processMeshesIncremental(meshDataBatch);
      }

      totalGeometries += batch.length;
      totalInstances += batch.reduce((sum, g) => sum + g.instance_count, 0);

      // Get current coordinate info for this batch
      const coordinateInfo = this.coordinateHandler.getCurrentCoordinateInfo();

      yield {
        type: 'batch',
        geometries: batch,
        totalSoFar: totalGeometries,
        coordinateInfo: coordinateInfo || undefined
      };
    }

    const coordinateInfo = this.coordinateHandler.getFinalCoordinateInfo();

    yield { type: 'complete', totalGeometries, totalInstances, coordinateInfo };
  }

  /**
   * Process IFC file in parallel using Web Workers.
   * Each worker gets its own WASM instance and processes a disjoint slice
   * of the geometry entity list. Batches are yielded as they arrive from
   * any worker, enabling progressive rendering while utilizing multiple cores.
   *
   * @param buffer IFC file buffer
   */
  async *processParallel(
    buffer: Uint8Array,
    sharedRtcOffset?: { x: number; y: number; z: number },
    /** Reuse a SAB the caller has already shared with another worker. */
    existingSab?: SharedArrayBuffer,
  ): AsyncGenerator<StreamingGeometryEvent> {
    // Initialize if needed
    if (!this.bridge?.isInitialized()) {
      await this.init();
    }

    yield* processParallel(buffer, this.coordinateHandler, sharedRtcOffset, existingSab);
  }

  /**
   * Adaptive processing: Choose sync or streaming based on file size
   * Small files (< threshold): Load all at once for instant display
   * Large files (>= threshold): Stream for fast first frame
   * @param buffer IFC file buffer
   * @param options Configuration options
   * @param options.sizeThreshold File size threshold in bytes (default: 2MB)
   * @param options.batchSize Number of meshes per batch for streaming (default: 25)
   * @param options.entityIndex Optional entity index for priority-based loading
   */
  async *processAdaptive(
    buffer: Uint8Array,
    options: {
      sizeThreshold?: number;
      batchSize?: number | DynamicBatchConfig;
      entityIndex?: Map<number, any>;
      /** Shared RTC offset from first federated model (IFC Z-up coords).
       *  Overrides per-model RTC detection for federation alignment. */
      sharedRtcOffset?: { x: number; y: number; z: number };
      /** Reuse a SAB already populated by the caller (parser worker, etc.). */
      existingSab?: SharedArrayBuffer;
    } = {}
  ): AsyncGenerator<StreamingGeometryEvent> {
    const sizeThreshold = options.sizeThreshold ?? 2 * 1024 * 1024; // Default 2MB
    const batchConfig = options.batchSize ?? 25;

    // Initialize if needed
    if (this.isNative) {
      if (!this.platformBridge) {
        await this.init();
      }
    } else if (!this.bridge?.isInitialized()) {
      await this.init();
    }

    // Reset coordinate handler for new file
    this.coordinateHandler.reset();

    // Small files: Load all at once (sync)
    if (buffer.length < sizeThreshold) {
      yield { type: 'start', totalEstimate: buffer.length / 1000 };

      yield { type: 'model-open', modelID: 0 };

      let allMeshes: MeshData[];

      if (this.isNative && this.platformBridge) {
        // NATIVE PATH - single batch processing
        console.time('[GeometryProcessor] native-adaptive-sync');
        const result = await this.platformBridge.processGeometry(buffer);
        allMeshes = result.meshes;
        console.timeEnd('[GeometryProcessor] native-adaptive-sync');
      } else {
        // WASM PATH
        const decoder = new TextDecoder();
        const content = decoder.decode(buffer);
        const collector = new IfcLiteMeshCollector(this.bridge!.getApi(), content);
        allMeshes = collector.collectMeshes();
      }

      // NOTE: The sync path (<2MB) does not support sharedRtcOffset override.
      // Infrastructure models with large coordinates are always >2MB and use
      // the parallel/streaming paths where shared RTC is properly threaded.

      // Process coordinate shifts
      this.coordinateHandler.processMeshesIncremental(allMeshes);
      const coordinateInfo = this.coordinateHandler.getFinalCoordinateInfo();

      // Emit as single batch for immediate rendering
      yield {
        type: 'batch',
        meshes: allMeshes,
        totalSoFar: allMeshes.length,
        coordinateInfo: coordinateInfo || undefined,
      };

      yield { type: 'complete', totalMeshes: allMeshes.length, coordinateInfo };
    } else {
      // Large files: parallel or streaming
      const useParallel = typeof SharedArrayBuffer !== 'undefined'
        && typeof Worker !== 'undefined'
        && typeof navigator !== 'undefined'
        && (navigator.hardwareConcurrency ?? 1) > 1;

      if (useParallel) {
        yield* this.processParallel(buffer, options.sharedRtcOffset, options.existingSab);
      } else {
        yield* this.processStreaming(buffer, options.entityIndex, batchConfig, options.sharedRtcOffset);
      }
    }
  }

  /**
   * Get the WASM API instance for advanced operations (e.g., entity scanning)
   */
  getApi() {
    if (!this.bridge || !this.bridge.isInitialized()) {
      return null;
    }
    return this.bridge.getApi();
  }

  getLastNativeStats(): PlatformGeometryStats | null {
    return this.lastNativeStats;
  }

  // enqueueNativeStreamingEvent and streamNativeGeometry have been
  // extracted to ./geometry-native.ts

  /**
   * Parse symbolic representations (Plan, Annotation, FootPrint) from IFC content
   * These are pre-authored 2D curves for architectural drawings (door swings, window cuts, etc.)
   * @param buffer IFC file buffer
   * @returns Collection of symbolic polylines and circles
   */
  parseSymbolicRepresentations(buffer: Uint8Array): import('@ifc-lite/wasm').SymbolicRepresentationCollection | null {
    if (!this.bridge || !this.bridge.isInitialized()) {
      return null;
    }
    const decoder = new TextDecoder();
    const content = decoder.decode(buffer);
    return this.bridge.parseSymbolicRepresentations(content);
  }

  /**
   * Extract raw profile polygons from IfcExtrudedAreaSolid building elements.
   * Returns clean per-element profile outlines + 3D placement transforms.
   * Used by Drawing2DGenerator for artifact-free 2D projection.
   * @param buffer IFC file buffer
   * @param modelIndex Federation model index (0 for single-model files)
   * @returns Collection of ProfileEntryJs items, or null if not initialized
   */
  extractProfiles(buffer: Uint8Array, modelIndex: number = 0): import('@ifc-lite/wasm').ProfileCollection | null {
    if (!this.bridge || !this.bridge.isInitialized()) {
      return null;
    }
    const decoder = new TextDecoder();
    const content = decoder.decode(buffer);
    return this.bridge.extractProfiles(content, modelIndex);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    // No cleanup needed
  }
}
