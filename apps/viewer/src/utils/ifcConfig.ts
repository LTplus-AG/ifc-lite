/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC loading configuration constants and utilities
 * Extracted from useIfc.ts for reusability
 */

import type { DynamicBatchConfig } from '@ifc-lite/geometry';

// ============================================================================
// Server Configuration
// ============================================================================

/** IFC server URL - set via environment variable for server-side IFC processing */
export const SERVER_URL = import.meta.env.VITE_IFC_SERVER_URL || import.meta.env.VITE_SERVER_URL || '';

/**
 * Enable server-side IFC parsing (disabled by default — uses client-side WASM).
 *
 * The server URL may be present for other features (e.g. superset integration)
 * without intending to route normal IFC loading through it.
 *
 * To enable server-side IFC processing for development:
 *   1. Set VITE_IFC_SERVER_URL (or VITE_SERVER_URL) to the server endpoint
 *   2. Set VITE_USE_SERVER=true
 *
 * Example .env:
 *   VITE_IFC_SERVER_URL=https://ifc-server.example.com
 *   VITE_USE_SERVER=true
 */
export const USE_SERVER = SERVER_URL !== '' && import.meta.env.VITE_USE_SERVER === 'true';

// ============================================================================
// File Size Thresholds (in bytes unless noted)
// ============================================================================

/** Minimum file size to cache (10MB) - smaller files parse quickly anyway */
export const CACHE_SIZE_THRESHOLD = 10 * 1024 * 1024;

/** Maximum file size eligible for caching (150MB).
 *  Files above this are not cached at all because the source buffer is required
 *  for on-demand property/quantity extraction, spatial hierarchy elevations,
 *  and IFC re-export.  Caching without it would silently degrade those features,
 *  and including it would make the IndexedDB write prohibitively large. */
export const CACHE_MAX_SOURCE_SIZE = 150 * 1024 * 1024;

/** Route desktop IFCs above this threshold through the bounded-memory path. */
export const HUGE_NATIVE_FILE_THRESHOLD = 128 * 1024 * 1024;

/**
 * File size at which the browser-File-API entry path streams directly into a
 * `SharedArrayBuffer` instead of going through `await file.arrayBuffer()`.
 *
 * Below this threshold, the doubled peak (ArrayBuffer + SAB) is small enough
 * that the simpler one-shot read is preferable. Above it, the streaming path
 * shaves ~`fileSize` MB from peak memory and avoids hitting V8's per-buffer
 * allocation limits on huge files. (Issue #600.)
 */
export const STREAM_SAB_THRESHOLD = 256 * 1024 * 1024;

/** File size thresholds for various optimizations */
export const THRESHOLDS = {
  /** Use streaming Parquet above this (150MB) */
  STREAMING_MB: 150,
  /** Use Parquet vs JSON above this (10MB) */
  PARQUET_MB: 10,
  /** Large file threshold affecting batch sizing (50MB) */
  LARGE_FILE_MB: 50,
  /** Huge file threshold for aggressive batching (100MB) */
  HUGE_FILE_MB: 100,
  /** Don't cache files smaller than this (10MB) */
  CACHE_MIN_MB: 10,
} as const;

// ============================================================================
// Platform Detection
// ============================================================================

/** Detect if running in Tauri (desktop) environment */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ============================================================================
// Dynamic Batch Configuration
// ============================================================================

/**
 * Calculate dynamic batch config based on file size
 * Larger files get larger batches for better throughput
 *
 * @param fileSizeMB - File size in megabytes
 * @returns Batch configuration for geometry processing
 */
export function getDynamicBatchConfig(fileSizeMB: number): DynamicBatchConfig {
  if (fileSizeMB < 10) {
    // Small files: smaller batches for responsiveness
    return { initialBatchSize: 50, maxBatchSize: 200, fileSizeMB };
  } else if (fileSizeMB < 50) {
    // Medium files: balanced batching
    return { initialBatchSize: 100, maxBatchSize: 500, fileSizeMB };
  } else if (fileSizeMB < 100) {
    // Large files: larger batches for throughput
    return { initialBatchSize: 100, maxBatchSize: 1000, fileSizeMB };
  } else {
    // Huge files (100MB+): aggressive batching for maximum throughput
    return { initialBatchSize: 100, maxBatchSize: 3000, fileSizeMB };
  }
}

/**
 * Convert bytes to megabytes
 */
export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}
