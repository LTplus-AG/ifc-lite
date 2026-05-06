/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite bridge - initializes and manages IFC-Lite WASM for geometry processing
 * Replaces web-ifc-bridge.ts with native IFC-Lite implementation (1.9x faster)
 */

import { createLogger } from '@ifc-lite/data';
import init, {
  IfcAPI,
  MeshCollection,
  MeshDataJs,
  InstancedMeshCollection,
  InstancedGeometry,
  InstanceData,
  QuantizedScene,
  SymbolicRepresentationCollection,
  SymbolicPolyline,
  SymbolicCircle,
  ProfileCollection,
  ProfileEntryJs,
} from '@ifc-lite/wasm';
export type {
  MeshCollection,
  MeshDataJs,
  InstancedMeshCollection,
  InstancedGeometry,
  InstanceData,
  QuantizedScene,
  SymbolicRepresentationCollection,
  SymbolicPolyline,
  SymbolicCircle,
  ProfileCollection,
  ProfileEntryJs,
};

/**
 * Plain-data snapshot of a quantised scene with TypedArray views detached
 * from the underlying WASM memory. Once snapshotted, the source `QuantizedScene`
 * is freed — this side keeps independent buffer copies the renderer can
 * upload without worrying about WASM memory invalidation.
 */
export interface QuantizedSceneSnapshot {
  /** Interleaved 12 B/vertex (`unorm16x4` pos + `snorm8x4` oct-normal). */
  vertexData: Uint8Array;
  /** Mesh-local `u32` indices. */
  indexData: Uint32Array;
  /** Per-mesh records, 64 B each. AABB + offsets + instance range. */
  meshTable: Uint8Array;
  /** Per-instance records, 80 B each. mat4 + expressId + colours + flags. */
  instanceData: Uint8Array;
  meshCount: number;
  instanceCount: number;
  totalVertexCount: number;
  totalIndexCount: number;
  /** total placements / unique meshes — informational. */
  dedupRatio: number;
}

const log = createLogger('Geometry');
const FATAL_WASM_RELOAD_REQUIRED_MESSAGE = 'IFC-Lite WASM cannot recover from a fatal runtime error within the same document lifetime. Reload the page or recreate the worker process before calling init() again.';
let fatalWasmRuntimeError: Error | null = null;

export interface StreamingProgress {
  percent: number;
  processed: number;
  total: number;
  phase: 'simple' | 'simple_complete' | 'complex';
}

export interface StreamingStats {
  totalMeshes: number;
  totalVertices: number;
  totalTriangles: number;
}

export interface InstancedStreamingStats {
  totalGeometries: number;
  totalInstances: number;
}

export interface ParseMeshesAsyncOptions {
  batchSize?: number;
  // NOTE: WASM automatically defers style building for faster first frame
  onBatch?: (meshes: MeshDataJs[], progress: StreamingProgress) => void;
  onComplete?: (stats: StreamingStats) => void;
  onColorUpdate?: (updates: Map<number, [number, number, number, number]>) => void;
}

export interface ParseMeshesInstancedAsyncOptions {
  batchSize?: number;
  onBatch?: (geometries: InstancedGeometry[], progress: StreamingProgress) => void;
  onComplete?: (stats: InstancedStreamingStats) => void;
}

export class IfcLiteBridge {
  private ifcApi: IfcAPI | null = null;
  private initialized: boolean = false;

  private isWasmRuntimeError(error: unknown): boolean {
    return error instanceof WebAssembly.RuntimeError;
  }

  private markFatalWasmRuntimeError(): void {
    fatalWasmRuntimeError = new Error(FATAL_WASM_RELOAD_REQUIRED_MESSAGE);
    this.reset();
  }

  /**
   * Initialize IFC-Lite WASM
   * The WASM binary is automatically resolved from the same location as the JS module
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (fatalWasmRuntimeError) {
      throw fatalWasmRuntimeError;
    }

    try {
      // Initialize WASM module - wasm-bindgen automatically resolves the WASM URL
      // from import.meta.url, no need to manually construct paths
      await init();

      // Thread pool initialization is DISABLED.
      // wasm-bindgen-rayon's initThreadPool creates workers that import the WASM
      // module via ../../.. — this path doesn't resolve in Vite production builds,
      // causing workers to hang forever and corrupt the WASM closure state.
      // Without the thread pool, rayon's par_iter() falls back to sequential.
      log.warn('Geometry processing: single-threaded mode (thread pool disabled for Vite compatibility)');

      this.ifcApi = new IfcAPI();
      this.initialized = true;
      log.info('WASM geometry engine initialized');
    } catch (error) {
      log.error('Failed to initialize WASM geometry engine', error, {
        operation: 'init',
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      } else {
        this.reset();
      }
      throw error;
    }
  }

  /**
   * Reset the JS wrapper state.
   * This does not reload wasm-bindgen's module singleton after a fatal WASM panic.
   */
  reset(): void {
    this.initialized = false;
    this.ifcApi = null;
  }

  /**
   * Parse IFC content and return mesh collection (blocking)
   * Returns individual meshes with express IDs and colors
   */
  parseMeshes(content: string): MeshCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.parseMeshes(content);
      log.debug(`Parsed ${collection.length} meshes`, { operation: 'parseMeshes' });
      return collection;
    } catch (error) {
      log.error('Failed to parse IFC geometry', error, {
        operation: 'parseMeshes',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Parse IFC content and return instanced geometry collection (blocking)
   * Groups identical geometries by hash and returns instances with transforms
   * Reduces draw calls significantly for buildings with repeated elements
   */
  parseMeshesInstanced(content: string): InstancedMeshCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.parseMeshesInstanced(content);
      log.debug(`Parsed ${collection.length} instanced geometries`, { operation: 'parseMeshesInstanced' });
      return collection;
    } catch (error) {
      log.error('Failed to parse instanced IFC geometry', error, {
        operation: 'parseMeshesInstanced',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Parse IFC content into a quantised + instanced scene snapshot ready for
   * direct WebGPU upload. This is the path the WebGPU viewer uses by default
   * — the legacy `parseMeshes*` methods stay only for headless/CLI consumers.
   *
   * Returns plain-data buffers (TypedArrays) detached from WASM memory so the
   * caller can hold them across re-entry into other WASM calls. The returned
   * snapshot collapses identical representations: instance count is total
   * placements, mesh count is unique meshes after content-hash dedup.
   */
  parseQuantizedInstancedScene(content: string): QuantizedSceneSnapshot {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let scene: QuantizedScene | null = null;
    try {
      scene = this.ifcApi.parseQuantizedInstanced(content);
      const memory = this.ifcApi.getMemory() as { buffer: ArrayBufferLike };
      // Slice each view out of WASM memory. `.slice()` copies, which is what we
      // want — ownership transfers to plain ArrayBuffers we own and the WASM
      // bundle can be freed without invalidating the snapshot.
      const vertexData = new Uint8Array(memory.buffer, scene.vertexDataPtr, scene.vertexDataByteLength).slice();
      const indexData = new Uint32Array(memory.buffer, scene.indexDataPtr, scene.indexDataLen).slice();
      const meshTable = new Uint8Array(memory.buffer, scene.meshTablePtr, scene.meshTableByteLength).slice();
      const instanceData = new Uint8Array(memory.buffer, scene.instanceDataPtr, scene.instanceDataByteLength).slice();
      const snapshot: QuantizedSceneSnapshot = {
        vertexData,
        indexData,
        meshTable,
        instanceData,
        meshCount: scene.meshCount,
        instanceCount: scene.instanceCount,
        totalVertexCount: scene.totalVertexCount,
        totalIndexCount: scene.totalIndexCount,
        dedupRatio: scene.dedupRatio,
      };
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      log.info(
        `[quantized] parsed ${snapshot.meshCount} unique meshes / ${snapshot.instanceCount} instances ` +
        `(dedup ${snapshot.dedupRatio.toFixed(1)}×, ` +
        `${snapshot.totalVertexCount} verts, ${snapshot.totalIndexCount / 3 | 0} tris, ` +
        `${(t1 - t0).toFixed(0)}ms)`,
        { operation: 'parseQuantizedInstancedScene' },
      );
      return snapshot;
    } catch (error) {
      log.error('[quantized] failed to parse IFC scene', error, {
        operation: 'parseQuantizedInstancedScene',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    } finally {
      // Free the WASM-side scene; the JS snapshot is independent.
      scene?.free();
    }
  }

  /**
   * Parse IFC content with streaming (non-blocking)
   * Yields batches progressively for fast first frame
   * Simple geometry (walls, slabs, beams) processed first
   */
  async parseMeshesAsync(content: string, options: ParseMeshesAsyncOptions = {}): Promise<void> {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return await this.ifcApi.parseMeshesAsync(content, options);
    } catch (error) {
      log.error('Failed to parse IFC geometry (streaming)', error, {
        operation: 'parseMeshesAsync',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Parse IFC content with streaming instanced geometry (non-blocking)
   * Groups identical geometries and yields batches progressively
   * Simple geometry (walls, slabs, beams) processed first
   * Reduces draw calls significantly for buildings with repeated elements
   */
  async parseMeshesInstancedAsync(content: string, options: ParseMeshesInstancedAsyncOptions = {}): Promise<void> {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return await this.ifcApi.parseMeshesInstancedAsync(content, options);
    } catch (error) {
      log.error('Failed to parse instanced IFC geometry (streaming)', error, {
        operation: 'parseMeshesInstancedAsync',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Parse IFC content and return symbolic representations (Plan, Annotation, FootPrint)
   * These are pre-authored 2D curves for architectural drawings
   */
  parseSymbolicRepresentations(content: string): SymbolicRepresentationCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.parseSymbolicRepresentations(content);
      log.debug(`Parsed ${collection.totalCount} symbolic items (${collection.polylineCount} polylines, ${collection.circleCount} circles)`, { operation: 'parseSymbolicRepresentations' });
      return collection;
    } catch (error) {
      log.error('Failed to parse symbolic representations', error, {
        operation: 'parseSymbolicRepresentations',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Extract raw profile polygons from all IfcExtrudedAreaSolid building elements.
   *
   * Returns profile outlines + placement transforms for clean 2D projection
   * without the tessellation artifacts that EdgeExtractor produces.
   *
   * @param content    Raw IFC file text.
   * @param modelIndex Federation model index (use 0 for single-model files).
   */
  extractProfiles(content: string, modelIndex: number = 0): ProfileCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.extractProfiles(content, modelIndex);
      log.debug(`Extracted ${collection.length} profiles`, { operation: 'extractProfiles' });
      return collection;
    } catch (error) {
      log.error('Failed to extract profiles', error, {
        operation: 'extractProfiles',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Parse a subset of IFC geometry entities by index range.
   * Performs the full pre-pass but only processes entities in [startIdx, endIdx).
   * Designed for Web Worker parallelization where each worker handles a slice.
   */
  parseMeshesSubset(content: string, startIdx: number, endIdx: number, skipExpensive: boolean = false): MeshCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.parseMeshesSubset(content, startIdx, endIdx, skipExpensive);
      log.debug(`Parsed subset [${startIdx}, ${endIdx}) → ${collection.length} meshes`, { operation: 'parseMeshesSubset' });
      return collection;
    } catch (error) {
      log.error('Failed to parse IFC geometry subset', error, {
        operation: 'parseMeshesSubset',
        data: { contentLength: content.length, startIdx, endIdx },
      });
      if (this.isWasmRuntimeError(error)) {
        this.markFatalWasmRuntimeError();
      }
      throw error;
    }
  }

  /**
   * Get IFC-Lite API instance
   */
  getApi(): IfcAPI {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    return this.ifcApi;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get version
   */
  getVersion(): string {
    return this.ifcApi?.version ?? 'unknown';
  }
}
