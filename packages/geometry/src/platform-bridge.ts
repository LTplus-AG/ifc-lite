/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Platform Bridge Abstraction
 *
 * Provides a unified interface for geometry processing that works in both:
 * - Web browsers (using WASM via @ifc-lite/wasm)
 * - Tauri desktop apps (using native Rust via Tauri commands)
 *
 * The appropriate implementation is selected at runtime based on environment detection.
 */

import type { MeshData, CoordinateInfo } from './types.js';

/**
 * Progress information during streaming geometry processing
 */
export interface StreamingProgress {
  processed: number;
  total: number;
  currentType: string;
}

export interface NativeBatchTelemetry {
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
}

export interface MetadataBootstrapEntitySummary {
  expressId: number;
  typeName: string;
  name: string;
  globalId?: string | null;
  kind: string;
  hasChildren: boolean;
  elementCount?: number;
  elevation?: number | null;
}

export interface MetadataBootstrapSpatialNode extends MetadataBootstrapEntitySummary {
  children: MetadataBootstrapSpatialNode[];
  elements: MetadataBootstrapEntitySummary[];
}

export interface MetadataBootstrapPayload {
  cacheKey: string;
  schemaVersion: string;
  entityCount: number;
  spatialTree: MetadataBootstrapSpatialNode | null;
}

/**
 * Batch of meshes emitted during streaming
 */
export interface GeometryBatch {
  meshes: MeshData[];
  progress: StreamingProgress;
  nativeTelemetry?: NativeBatchTelemetry;
}

/**
 * Statistics returned after geometry processing completes
 */
export interface GeometryStats {
  totalMeshes: number;
  totalVertices: number;
  totalTriangles: number;
  parseTimeMs: number;
  entityScanTimeMs?: number;
  lookupTimeMs?: number;
  preprocessTimeMs?: number;
  geometryTimeMs: number;
  totalTimeMs?: number;
  firstChunkReadyTimeMs?: number;
  firstChunkPackTimeMs?: number;
  firstChunkEmittedTimeMs?: number;
  firstChunkEmitTimeMs?: number;
}

/**
 * Complete geometry result from processing
 */
export interface GeometryProcessingResult {
  meshes: MeshData[];
  totalVertices: number;
  totalTriangles: number;
  coordinateInfo: CoordinateInfo;
}

/**
 * Options for streaming geometry processing
 */
export interface StreamingOptions {
  /** Callback for each batch of meshes */
  onBatch?: (batch: GeometryBatch) => void;
  /** Callback for early metadata bootstrap when available */
  onMetadataBootstrap?: (bootstrap: MetadataBootstrapPayload) => void;
  /** Callback for deferred color updates */
  onColorUpdate?: (updates: Map<number, [number, number, number, number]>) => void;
  /** Callback when processing is complete */
  onComplete?: (stats: GeometryStats) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
}

/**
 * Platform bridge interface - abstracts WASM vs native processing
 */
export interface IPlatformBridge {
  /**
   * Initialize the bridge (WASM loading for web, no-op for native)
   */
  init(): Promise<void>;

  /**
   * Check if the bridge is initialized
   */
  isInitialized(): boolean;

  /**
   * Process IFC content and return all geometry at once
   * @param content IFC file content as string or raw bytes
   */
  processGeometry(content: string | Uint8Array): Promise<GeometryProcessingResult>;

  /**
   * Process IFC geometry directly from a filesystem path when supported.
   * Native desktop bridges can avoid copying huge files through JS/IPC.
   */
  processGeometryPath?(path: string): Promise<GeometryProcessingResult>;

  /**
   * Process IFC content with streaming output
   * @param content IFC file content as string or raw bytes
   * @param options Streaming options with callbacks
   */
  processGeometryStreaming(content: string | Uint8Array, options: StreamingOptions): Promise<GeometryStats>;

  /**
   * Stream IFC geometry directly from a filesystem path when supported.
   */
  processGeometryStreamingPath?(path: string, options: StreamingOptions, cacheKey?: string): Promise<GeometryStats>;

  /**
   * Stream previously cached native desktop geometry by cache key.
   */
  processGeometryStreamingCache?(cacheKey: string, options: StreamingOptions): Promise<GeometryStats>;

  /**
   * Get the underlying API object (for advanced usage)
   * Returns the WASM IfcAPI in web, or null in Tauri
   */
  getApi(): unknown | null;
}

/**
 * Detect if running in Tauri desktop environment
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Create the appropriate platform bridge based on runtime environment.
 *
 * Only used on the native (Tauri) path — `GeometryProcessor` calls this
 * exclusively when `isNative` (which requires `isTauri()`), so the browser
 * never reaches here. In the browser, geometry runs through the WASM
 * `GeometryProcessor.bridge` (`IfcLiteBridge`) + pre-pass/job-batch path
 * directly, not through a platform bridge.
 */
export async function createPlatformBridge(): Promise<IPlatformBridge> {
  if (isTauri()) {
    const { NativeBridge } = await import('./native-bridge.js');
    return new NativeBridge();
  }
  throw new Error(
    'createPlatformBridge() is native-only; the browser uses the WASM GeometryProcessor path directly.',
  );
}
