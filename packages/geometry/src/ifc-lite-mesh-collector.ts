/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite Mesh Collector - extracts triangle data from IFC-Lite WASM
 * Replaces mesh-collector.ts - uses native Rust geometry processing (1.9x faster)
 */

import { createLogger } from '@ifc-lite/data';
import type { IfcAPI, MeshDataJs, InstancedGeometry, MeshCollection } from '@ifc-lite/wasm';
import type { MeshData } from './types.js';

const log = createLogger('MeshCollector');

export interface StreamingProgress {
  percent: number;
  processed: number;
  total: number;
  phase: 'simple' | 'simple_complete' | 'complex';
}

export interface StreamingBatchEvent {
  type: 'batch';
  meshes: MeshData[];
  progress: StreamingProgress;
}

export interface StreamingCompleteEvent {
  type: 'complete';
  stats: {
    totalMeshes: number;
    totalVertices: number;
    totalTriangles: number;
  };
}

export interface StreamingColorUpdateEvent {
  type: 'colorUpdate';
  updates: Map<number, [number, number, number, number]>;
}

export interface StreamingRtcOffsetEvent {
  type: 'rtcOffset';
  /** RTC offset in IFC coordinates (before Z-up to Y-up conversion) */
  rtcOffset: { x: number; y: number; z: number };
  hasRtc: boolean;
}

export type StreamingEvent = StreamingBatchEvent | StreamingCompleteEvent | StreamingColorUpdateEvent | StreamingRtcOffsetEvent;

/**
 * Optional constructor options for the mesh collector. Currently used
 * to forward the Revit-style multilayer-wall merge flag from the
 * viewer's UI toggle (issue #540) down to the WASM API before the
 * first `parseMeshes*` call.
 */
export interface IfcLiteMeshCollectorOptions {
  /**
   * When true, the WASM mesh emitters suppress `IfcBuildingElementPart`
   * meshes whose parent wall is sliceable. Default `false` keeps the
   * existing per-layer behaviour.
   */
  mergeLayers?: boolean;
}

/**
 * Narrow typed wrapper for the optional `setMergeLayers` extension.
 * Once the Rust agent regenerates the WASM `.d.ts` this cast is
 * redundant — keeping it small and local avoids the need for
 * `as any` / `@ts-ignore` in the meantime.
 */
type IfcAPIWithMerge = IfcAPI & { setMergeLayers?: (enabled: boolean) => void };

export class IfcLiteMeshCollector {
  private ifcApi: IfcAPI;
  private content: string;
  private _buildingRotation: number | undefined;
  private mergeLayers: boolean;
  private mergeLayersApplied: boolean = false;

  constructor(ifcApi: IfcAPI, content: string, options: IfcLiteMeshCollectorOptions = {}) {
    this.ifcApi = ifcApi;
    this.content = content;
    this.mergeLayers = options.mergeLayers === true;
  }

  /**
   * Forward the cached `mergeLayers` flag to the IfcAPI once per
   * collector instance. The Rust agent's contract is "state on the
   * IfcAPI carries forward to subsequent parseMeshes* calls", so we
   * only need to push the flag once before the first parse call.
   *
   * When the WASM build pre-dates the Rust agent's contract, the
   * method is missing — we tolerate that silently because the bridge
   * already logged a warning on its own `applyMergeLayers` path.
   */
  private ensureMergeLayersApplied(): void {
    if (this.mergeLayersApplied) return;
    this.mergeLayersApplied = true;
    const api = this.ifcApi as IfcAPIWithMerge;
    if (typeof api.setMergeLayers === 'function') {
      api.setMergeLayers(this.mergeLayers);
    }
  }

  /**
   * Convert IFC Z-up coordinates to WebGL Y-up coordinates
   * IFC uses Z-up (Z points up), WebGL uses Y-up (Y points up)
   * Transformation: swap Y and Z, then negate new Z to maintain right-handedness
   */
  private convertZUpToYUp(coords: Float32Array): void {
    for (let i = 0; i < coords.length; i += 3) {
      const y = coords[i + 1];
      const z = coords[i + 2];
      // Swap Y and Z: Z-up → Y-up
      coords[i + 1] = z;      // New Y = old Z (vertical)
      coords[i + 2] = -y;     // New Z = -old Y (depth, negated for right-hand rule)
    }
  }

  /**
   * Reverse triangle winding order to correct for handedness flip.
   * The Z-up to Y-up conversion includes a reflection (Z negation),
   * which flips the handedness. This reverses winding to compensate,
   * ensuring triangles face the correct direction after transformation.
   */
  private reverseWindingOrder(indices: Uint32Array): void {
    // Calculate last valid triangle index to avoid out-of-bounds access
    const remainder = indices.length % 3;
    const end = indices.length - remainder;

    // Warn if indices array has trailing non-triangle entries
    if (remainder !== 0) {
      console.warn(`[reverseWindingOrder] Index buffer has ${remainder} trailing entries (not divisible by 3)`);
    }

    for (let i = 0; i < end; i += 3) {
      // Swap second and third vertex of each triangle
      const temp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = temp;
    }
  }

  /**
   * Collect all meshes from IFC-Lite
   * Much faster than web-ifc (~1.9x speedup)
   */
  collectMeshes(): MeshData[] {
    this.ensureMergeLayersApplied();
    let collection: MeshCollection;
    try {
      collection = this.ifcApi.parseMeshes(this.content);
    } catch (error) {
      log.error('WASM mesh parsing failed', error, { operation: 'collectMeshes' });
      throw error;
    }

    const meshes: MeshData[] = [];
    let failedMeshes = 0;

    // Convert MeshCollection to MeshData[]
    for (let i = 0; i < collection.length; i++) {
      let mesh: ReturnType<typeof collection.get> | null = null;
      try {
        mesh = collection.get(i);
        if (!mesh) {
          failedMeshes++;
          continue;
        }

        // Get color array [r, g, b, a]
        const colorArray = mesh.color;
        const color: [number, number, number, number] = [
          colorArray[0],
          colorArray[1],
          colorArray[2],
          colorArray[3],
        ];

        // Optional SurfaceColour for the GLB exporter's "Shading" mode.
        // Absent when the file didn't author a distinct DiffuseColour
        // (the common case) — the exporter falls back to `color`.
        const shadingArray = (mesh as { shadingColor?: ArrayLike<number> }).shadingColor;
        const shadingColor: [number, number, number, number] | undefined =
          shadingArray && shadingArray.length === 4
            ? [shadingArray[0], shadingArray[1], shadingArray[2], shadingArray[3]]
            : undefined;

        // Z-up→Y-up conversion and winding order reversal are now done
        // in Rust (MeshDataJs::new) for performance.
        meshes.push({
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          color,
          ...(shadingColor ? { shadingColor } : {}),
        });

        // Free the individual mesh to avoid memory leaks
        mesh.free();
        mesh = null; // Mark as freed
      } catch (error) {
        failedMeshes++;
        log.caught(`Failed to process mesh ${i}`, error, { operation: 'collectMeshes' });
        // Ensure mesh is freed even on error
        if (mesh) {
          try {
            mesh.free();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
    }

    // Extract building rotation before freeing collection
    const buildingRotation = collection.buildingRotation ?? undefined;

    // Free the collection
    collection.free();

    if (failedMeshes > 0) {
      log.warn(`Skipped ${failedMeshes} meshes due to errors`, { operation: 'collectMeshes' });
    }

    log.debug(`Collected ${meshes.length} meshes`, { operation: 'collectMeshes' });

    // Store building rotation for later use (will be added to CoordinateInfo)
    this._buildingRotation = buildingRotation;

    return meshes;
  }

  /**
   * Get building rotation extracted from IfcSite placement
   */
  getBuildingRotation(): number | undefined {
    return this._buildingRotation;
  }

  /**
   * Collect meshes incrementally, yielding batches for progressive rendering
   * Uses fast-first-frame streaming: simple geometry (walls, slabs) first
   * @param batchSize Number of meshes per batch (default: 25 for faster first frame)
   */
  async *collectMeshesStreaming(batchSize: number = 25): AsyncGenerator<MeshData[] | StreamingColorUpdateEvent | StreamingRtcOffsetEvent> {
    this.ensureMergeLayersApplied();
    // Queue to hold batches produced by async callback
    const batchQueue: (MeshData[] | StreamingColorUpdateEvent | StreamingRtcOffsetEvent)[] = [];
    let resolveWaiting: (() => void) | null = null;
    let isComplete = false;
    let processingError: Error | null = null;
    // Map to store color updates for pending batches
    const colorUpdates = new Map<number, [number, number, number, number]>();
    let totalMeshesProcessed = 0;
    let failedMeshCount = 0;

    // Start async processing
    // NOTE: WASM now automatically defers style building for faster first frame
    const processingPromise = this.ifcApi.parseMeshesAsync(this.content, {
      batchSize,
      onRtcOffset: (rtc: { x: number; y: number; z: number; hasRtc: boolean }) => {
        // Emit RTC offset event so consumer can capture it
        batchQueue.push({
          type: 'rtcOffset',
          rtcOffset: { x: rtc.x, y: rtc.y, z: rtc.z },
          hasRtc: rtc.hasRtc,
        });
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onColorUpdate: (updates: Map<number, [number, number, number, number]>) => {
        // Store color updates
        for (const [expressId, color] of updates) {
          colorUpdates.set(expressId, color);
        }
        // Emit color update event
        batchQueue.push({
          type: 'colorUpdate',
          updates: new Map(updates),
        });
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onBatch: (meshes: MeshDataJs[], _progress: StreamingProgress) => {
        // Convert WASM meshes to MeshData[]
        const convertedBatch: MeshData[] = [];

        for (const mesh of meshes) {
          try {
            // Use updated color if available, otherwise use mesh color
            const expressId = mesh.expressId;
            const color: [number, number, number, number] = colorUpdates.get(expressId) ?? [
              mesh.color[0],
              mesh.color[1],
              mesh.color[2],
              mesh.color[3],
            ];

            // Capture arrays once — Z-up→Y-up conversion and winding order
            // reversal are now done in Rust (MeshDataJs::new) for performance.
            convertedBatch.push({
              expressId,
              ifcType: mesh.ifcType,
              positions: mesh.positions,
              normals: mesh.normals,
              indices: mesh.indices,
              color,
            });

            // Free the mesh to avoid memory leaks
            mesh.free();
            totalMeshesProcessed++;
          } catch (error) {
            failedMeshCount++;
            log.caught(`Failed to process mesh #${mesh.expressId}`, error, {
              operation: 'collectMeshesStreaming',
              entityId: mesh.expressId,
            });
            try {
              mesh.free();
            } catch {
              // Ignore free errors
            }
          }
        }

        // Add batch to queue
        if (convertedBatch.length > 0) {
          batchQueue.push(convertedBatch);
        }

        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onComplete: (stats: { totalMeshes: number; totalVertices: number; totalTriangles: number; rtcOffset?: { x: number; y: number; z: number; hasRtc: boolean }; buildingRotation?: number; csgDiagnostics?: { classification?: { rectangular?: number; diagonal?: number; nonRectangular?: number; floorOpeningGuardSaved?: number; total?: number }; totalFailures?: number; productsWithFailures?: number; hostsWithOpenings?: number } }) => {
        isComplete = true;

        // Store building rotation if present
        if (stats.buildingRotation !== undefined) {
          this._buildingRotation = stats.buildingRotation;
        }

        log.debug(`Streaming complete: ${stats.totalMeshes} meshes, ${stats.totalVertices} vertices, ${stats.totalTriangles} triangles`, {
          operation: 'collectMeshesStreaming',
        });
        if (failedMeshCount > 0) {
          log.warn(`Skipped ${failedMeshCount} meshes due to errors`, { operation: 'collectMeshesStreaming' });
        }

        // T1.3 / classifier-fix diagnostics: surface the structured CSG
        // diagnostics object the WASM bindings attach to `stats`. Logged
        // here on the JS side too because `web_sys::console::*` from
        // inside the WASM streaming path can be invisible in some
        // browser/build combos (worker boundary, log-level filtering).
        // A JS console.warn is the most reliable "always shows up" channel.
        const diag = stats.csgDiagnostics;
        if (diag) {
          const totalFailures = diag.totalFailures ?? 0;
          // Only surface a `console.warn` when the kernel actually dropped
          // a cut — successful parses shouldn't add noise to host apps
          // embedding the viewer. The full diagnostics object is still
          // attached to `stats.csgDiagnostics` for callers that want it.
          if (totalFailures > 0) {
            const c = diag.classification ?? {};
            // eslint-disable-next-line no-console
            console.warn(
              `[IFC-LITE] CSG diagnostics (JS): classifier=${JSON.stringify(c)}, ` +
                `totalFailures=${totalFailures}, ` +
                `productsWithFailures=${diag.productsWithFailures ?? 0}, ` +
                `hostsWithOpenings=${diag.hostsWithOpenings ?? 0}`,
            );
          }
        }
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
    }).catch((error: unknown) => {
      processingError = error instanceof Error ? error : new Error(String(error));
      log.error('WASM streaming parsing failed', processingError, { operation: 'collectMeshesStreaming' });
      isComplete = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    });

    // Yield batches as they become available
    let yieldedBatchCount = 0;
    while (true) {
      // Yield any queued batches
      while (batchQueue.length > 0) {
        yieldedBatchCount++;
        yield batchQueue.shift()!;
      }

      // Check for errors
      if (processingError) {
        throw processingError;
      }

      // Check if we're done
      if (isComplete && batchQueue.length === 0) {
        break;
      }

      // Wait for more batches
      await new Promise<void>((resolve) => {
        resolveWaiting = resolve;
      });
    }

    // Warn if WASM returned 0 results for a non-trivially-sized file
    // This typically indicates WASM ran out of memory during parsing
    if (yieldedBatchCount === 0 && this.content.length > 1000) {
      const sizeMB = (this.content.length / (1024 * 1024)).toFixed(1);
      log.warn(
        `WASM streaming returned 0 batches for ${sizeMB}MB file - ` +
        `this may indicate insufficient memory for large file processing`,
        { operation: 'collectMeshesStreaming', data: { contentLength: this.content.length } },
      );
    }

    // Ensure processing is complete
    await processingPromise;
  }

  /**
   * Collect meshes with dynamic batch sizing (ramp-up approach)
   * Accumulates meshes from WASM and yields them in dynamically-sized batches
   * @param getBatchSize Function that returns batch size for current batch number
   */
  async *collectMeshesStreamingDynamic(
    getBatchSize: () => number
  ): AsyncGenerator<MeshData[]> {
    let batchNumber = 0;
    let accumulatedMeshes: MeshData[] = [];
    let currentBatchSize = getBatchSize();

    // Use larger WASM batches to reduce callback overhead
    // First frame responsiveness comes from WASM's internal simple/complex ordering
    // For huge files (>100MB), use 500 to minimize callbacks (20x fewer than 25)
    const wasmBatchSize = 500; // Larger batches = fewer callbacks = faster

    for await (const item of this.collectMeshesStreaming(wasmBatchSize)) {
      // Skip color update events in dynamic batching
      if (item && typeof item === 'object' && 'type' in item && (item as StreamingColorUpdateEvent).type === 'colorUpdate') {
        continue;
      }
      const wasmBatch = item as MeshData[];
      for (let i = 0; i < wasmBatch.length; i++) accumulatedMeshes.push(wasmBatch[i]);

      // Yield when we've accumulated enough for current dynamic batch size
      while (accumulatedMeshes.length >= currentBatchSize) {
        const batchToYield = accumulatedMeshes.splice(0, currentBatchSize);
        yield batchToYield;

        // Update batch size for next batch
        batchNumber++;
        currentBatchSize = getBatchSize();
      }
    }

    // Yield remaining meshes
    if (accumulatedMeshes.length > 0) {
      yield accumulatedMeshes;
    }
  }

  /**
   * Collect instanced geometry incrementally, yielding batches for progressive rendering
   * Groups identical geometries by hash (before transformation) for GPU instancing
   * Uses fast-first-frame streaming: simple geometry (walls, slabs) first
   * @param batchSize Number of unique geometries per batch (default: 25)
   */
  async *collectInstancedGeometryStreaming(batchSize: number = 25): AsyncGenerator<InstancedGeometry[]> {
    this.ensureMergeLayersApplied();
    // Queue to hold batches produced by async callback
    const batchQueue: InstancedGeometry[][] = [];
    let resolveWaiting: (() => void) | null = null;
    let isComplete = false;
    let processingError: Error | null = null;

    // Start async processing
    const processingPromise = this.ifcApi.parseMeshesInstancedAsync(this.content, {
      batchSize,
      onBatch: (geometries: InstancedGeometry[], _progress: StreamingProgress) => {
        // NOTE: Do NOT convert Z-up to Y-up here for instanced geometry!
        // Instance transforms position geometry in world space.
        // If we convert local positions but not transforms, geometry breaks.
        // The viewer handles coordinate system in the camera/shader.
        // Add batch directly to queue without modification
        batchQueue.push(geometries);

        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
      onComplete: (_stats: { totalGeometries: number; totalInstances: number }) => {
        isComplete = true;
        // Wake up the generator if it's waiting
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      },
    }).catch((error: unknown) => {
      processingError = error instanceof Error ? error : new Error(String(error));
      log.error('WASM instanced streaming parsing failed', processingError, { operation: 'collectInstancedGeometryStreaming' });
      isComplete = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    });

    // Yield batches as they become available
    let yieldedBatchCount = 0;
    while (true) {
      // Yield any queued batches
      while (batchQueue.length > 0) {
        yieldedBatchCount++;
        yield batchQueue.shift()!;
      }

      // Check for errors
      if (processingError) {
        throw processingError;
      }

      // Check if we're done
      if (isComplete && batchQueue.length === 0) {
        break;
      }

      // Wait for more batches
      await new Promise<void>((resolve) => {
        resolveWaiting = resolve;
      });
    }

    // Warn if WASM returned 0 results for a non-trivially-sized file
    // This typically indicates WASM ran out of memory during parsing
    if (yieldedBatchCount === 0 && this.content.length > 1000) {
      const sizeMB = (this.content.length / (1024 * 1024)).toFixed(1);
      log.warn(
        `WASM instanced streaming returned 0 batches for ${sizeMB}MB file - ` +
        `this may indicate insufficient memory for large file processing`,
        { operation: 'collectInstancedGeometryStreaming', data: { contentLength: this.content.length } },
      );
    }

    // Ensure processing is complete
    await processingPromise;
  }
}
