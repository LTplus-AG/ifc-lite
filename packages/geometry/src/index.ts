/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/geometry - Geometry processing bridge
 * Now powered by IFC-Lite native Rust WASM (1.9x faster than web-ifc)
 */

// IFC-Lite components (recommended - faster)
export { IfcLiteBridge, type SymbolicRepresentationCollection, type SymbolicPolyline, type SymbolicCircle, type ProfileCollection, type ProfileEntryJs } from './ifc-lite-bridge.js';
import { safeUtf8Decode } from '@ifc-lite/data';

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
export { computeWorkerCount, pickWorkerCount, type WorkerCountInputs, type WorkerCountResult } from './worker-count.js';
export { getGeometryStreamWatchdogMs, type WatchdogInputs } from './watchdog.js';

export * from './types.js';

import { IfcLiteBridge } from './ifc-lite-bridge.js';
import { BufferBuilder } from './buffer-builder.js';
import { CoordinateHandler } from './coordinate-handler.js';
import { GeometryQuality } from './progressive-loader.js';
import { createPlatformBridge, isTauri, type GeometryStats as PlatformGeometryStats, type IPlatformBridge } from './platform-bridge.js';
import type { GeometryResult, MeshData, CoordinateInfo } from './types.js';

// Extracted sub-modules
import { getStreamingBatchSize, convertMeshCollectionToBatch, withBuildingRotation } from './geometry-coordinate.js';
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
  /**
   * When true, the underlying IFC-Lite WASM API merges Revit-style
   * multilayer walls — `IfcBuildingElementPart` meshes whose parent
   * wall is sliceable are suppressed. Default `false` keeps the
   * existing per-layer rendering behaviour. See issue #540.
   */
  mergeLayers?: boolean;
}

let activeWasmStreamingOperation: string | null = null;

function acquireWasmStreamingOperation(operation: string): () => void {
  if (activeWasmStreamingOperation) {
    throw new Error(
      `GeometryProcessor ${operation} cannot start while ${activeWasmStreamingOperation} is still running. ` +
      'Wait for the active stream to finish, or cancel it before starting another geometry operation.',
    );
  }
  activeWasmStreamingOperation = operation;
  return () => {
    if (activeWasmStreamingOperation === operation) {
      activeWasmStreamingOperation = null;
    }
  };
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
  /**
   * Liveness heartbeat from a long-running pre-pass / parallel pipeline.
   * Carries no payload other than a phase tag. Consumers should treat any
   * `progress` event as "pipeline still alive" and reset their watchdog.
   * Existing consumers safely ignore unknown discriminants — this variant
   * is additive.
   */
  | { type: 'progress'; phase: 'prepass' | 'workers' }
  | { type: 'complete'; totalMeshes: number; coordinateInfo: import('./types.js').CoordinateInfo };

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
  private mergeLayers: boolean;

  constructor(options: GeometryProcessorOptions = {}) {
    this.bufferBuilder = new BufferBuilder();
    this.coordinateHandler = new CoordinateHandler();
    this.isNative = options.preferNative !== false && isTauri();
    this.mergeLayers = options.mergeLayers === true;
    // Note: options accepted for API compatibility
    void options.quality;

    if (!this.isNative) {
      this.bridge = new IfcLiteBridge();
      // Cache the merge-layers flag on the bridge eagerly — if init()
      // hasn't run yet the bridge stores the value and replays it on
      // the freshly-built IfcAPI. Existing call sites can opt in
      // simply by passing { mergeLayers: true } into the constructor.
      this.bridge.setMergeLayers(this.mergeLayers);
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
   * Collect ALL meshes for a buffer via the Family-A pre-pass + job-batch
   * path — the same WASM entry points (`buildPrePassOnce` +
   * `processGeometryBatch`) that the worker pool and the >256 MB streaming
   * path already use. This is the single main-thread mesh-production
   * implementation; it replaces the legacy whole-file
   * `IfcLiteMeshCollector` / `parseMeshes` path.
   *
   * The merge-layers toggle is stateful on the bridge's IfcAPI (applied in
   * `init()` via `bridge.setMergeLayers`), so the batch path honours it
   * without any per-call argument. Bytes are passed straight through —
   * no `TextDecoder` materialization of the whole file.
   */
  private collectMeshesViaPrePass(buffer: Uint8Array): { meshes: MeshData[]; buildingRotation?: number } {
    if (!this.bridge) {
      throw new Error('WASM bridge not initialized');
    }

    const api = this.bridge.getApi();
    const prePass = api.buildPrePassOnce(buffer) as ByteStreamingPrePassResult;
    try {
      const meshes: MeshData[] = [];
      const totalJobs = prePass.totalJobs ?? 0;

      if (prePass.jobs && totalJobs > 0) {
        // One batch over all jobs — synchronous callers want the full set.
        const collection = api.processGeometryBatch(
          buffer,
          prePass.jobs,
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
        meshes.push(...convertMeshCollectionToBatch(collection));
      }

      return { meshes, buildingRotation: prePass.buildingRotation ?? undefined };
    } finally {
      // Always release the pre-pass cache — even if processGeometryBatch throws.
      api.clearPrePassCache?.();
    }
  }

  /**
   * Collect meshes on main thread using IFC-Lite WASM.
   */
  private async collectMeshesMainThread(buffer: Uint8Array, _entityIndex?: Map<number, any>): Promise<{ meshes: MeshData[]; buildingRotation?: number }> {
    return this.collectMeshesViaPrePass(buffer);
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

    // try/finally so the pre-pass cache is released on every exit: the
    // totalJobs===0 early return, a processGeometryBatch throw, or the
    // consumer abandoning the generator (which triggers `.return()`).
    try {
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

      const coordinateInfo = withBuildingRotation(
        this.coordinateHandler.getFinalCoordinateInfo(),
        buildingRotation,
      );
      yield { type: 'complete', totalMeshes, coordinateInfo };
    } finally {
      api.clearPrePassCache?.();
    }
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
    const releaseWasmOperation = this.isNative
      ? null
      : acquireWasmStreamingOperation('processStreaming');

    try {
      yield* this.processStreamingUnlocked(buffer, _entityIndex, batchConfig, sharedRtcOffset);
    } finally {
      releaseWasmOperation?.();
    }
  }

  private async *processStreamingUnlocked(
    buffer: Uint8Array,
    _entityIndex?: Map<number, any>,
    batchConfig: number | DynamicBatchConfig = 25,
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
      // WASM PATH — single-threaded fallback (no SAB / Worker). Route ALL
      // sizes through the Family-A pre-pass + job-batch streamer; the old
      // 256 MB gate (above which we already used `processStreamingBytes`)
      // is gone, so there is one byte-based streaming implementation and
      // the legacy whole-file `IfcLiteMeshCollector` is no longer used.
      if (!this.bridge) {
        throw new Error('WASM bridge not initialized');
      }

      yield* this.processStreamingBytes(buffer, batchConfig);
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
    /** Callback fired when the streaming pre-pass exports its entity index. */
    onEntityIndex?: (
      ids: Uint32Array,
      starts: Uint32Array,
      lengths: Uint32Array,
    ) => void,
    /**
     * Explicit wasm asset URL forwarded to the worker pool. See
     * `ProcessParallelOptions.wasmUrls` in `geometry-parallel.ts` for
     * the full rationale — needed only for bundlers that can't transform
     * `new URL('ifc-lite_bg.wasm', import.meta.url)` inside the worker
     * dist (or deployments that serve wasm from a separate origin).
     * Vite + webpack 5 consumers leave this undefined.
     */
    wasmUrls?: { wasm?: string },
  ): AsyncGenerator<StreamingGeometryEvent> {
    // Initialize if needed
    if (!this.bridge?.isInitialized()) {
      await this.init();
    }

    yield* processParallel(buffer, this.coordinateHandler, sharedRtcOffset, existingSab, {
      onEntityIndex,
      // Issue #540: forward the merge-layers preference snapshotted
      // at construction time. processParallel posts `set-merge-layers`
      // to every spawned worker right after `init`.
      mergeLayers: this.mergeLayers,
      wasmUrls,
    });
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
      /**
       * Callback fired when the streaming pre-pass exports its entity
       * index. Enables a peer worker (e.g. parser) to skip its own scan.
       * Only fires on the parallel-streaming path.
       */
      onEntityIndex?: (
        ids: Uint32Array,
        starts: Uint32Array,
        lengths: Uint32Array,
      ) => void;
      /**
       * Explicit wasm asset URL forwarded to the worker pool.
       * See `processParallel(...).wasmUrls` for rationale.
       */
      wasmUrls?: { wasm?: string };
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
      let buildingRotation: number | undefined;

      if (this.isNative && this.platformBridge) {
        // NATIVE PATH - single batch processing
        console.time('[GeometryProcessor] native-adaptive-sync');
        const result = await this.platformBridge.processGeometry(buffer);
        allMeshes = result.meshes;
        console.timeEnd('[GeometryProcessor] native-adaptive-sync');
      } else {
        // WASM PATH — Family-A pre-pass + job batches (SAB-safe, bytes in).
        const collected = this.collectMeshesViaPrePass(buffer);
        allMeshes = collected.meshes;
        buildingRotation = collected.buildingRotation;
      }

      // NOTE: The sync path (<2MB) does not support sharedRtcOffset override.
      // Infrastructure models with large coordinates are always >2MB and use
      // the parallel/streaming paths where shared RTC is properly threaded.

      // Process coordinate shifts
      this.coordinateHandler.processMeshesIncremental(allMeshes);
      const coordinateInfo = withBuildingRotation(
        this.coordinateHandler.getFinalCoordinateInfo(),
        buildingRotation,
      );

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
        yield* this.processParallel(
          buffer,
          options.sharedRtcOffset,
          options.existingSab,
          options.onEntityIndex,
          options.wasmUrls,
        );
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
    // SAB-safe: caller may pass a SharedArrayBuffer-backed view, which
    // both Firefox and Chromium reject in raw `TextDecoder.decode`.
    const content = safeUtf8Decode(buffer);
    return this.bridge.parseSymbolicRepresentations(content);
  }

  /**
   * Parse IfcAlignment directrix curves into a flat Float32Array of 3D
   * line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in renderer Y-up world space
   * (RTC-subtracted, metres). Rendered as thin lines (not a ribbon mesh) to
   * match IfcGrid / IfcAnnotation. Feed straight to `renderer.uploadAlignmentLines3D`.
   * @param buffer IFC file buffer
   * @returns Flat line-list vertices, or null if not initialized
   */
  parseAlignmentLines(buffer: Uint8Array): Float32Array | null {
    if (!this.bridge || !this.bridge.isInitialized()) {
      return null;
    }
    // SAB-safe: caller may pass a SharedArrayBuffer-backed view, which
    // both Firefox and Chromium reject in raw `TextDecoder.decode`.
    const content = safeUtf8Decode(buffer);
    return this.bridge.parseAlignmentLines(content);
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
    // SAB-safe: caller may pass a SharedArrayBuffer-backed view, which
    // both Firefox and Chromium reject in raw `TextDecoder.decode`.
    const content = safeUtf8Decode(buffer);
    return this.bridge.extractProfiles(content, modelIndex);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    // No cleanup needed
  }
}
