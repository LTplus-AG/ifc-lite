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

/** Maximum file size eligible for the SOURCE-DECOUPLED "mesh-only" cache tier
 *  (400MB, ON BY DEFAULT; kill switch `?meshCache=0` — see `isMeshOnlyCacheEnabled`).
 *
 *  Files in (CACHE_MAX_SOURCE_SIZE, CACHE_MESH_ONLY_MAX_SIZE] are too big to
 *  persist their source buffer in IndexedDB, but their tables + entityIndex +
 *  geometry + instanced shards CAN be cached without it. On re-open the freshly
 *  read file buffer hydrates the lazy property/quantity/export accessors (exactly
 *  the `fallbackSourceBuffer` path `loadFromCache` already supports), so repeat
 *  opens skip the 10-90s parse+mesh while keeping full feature fidelity.
 *
 *  The spread-sampled cache key (`sourceFingerprint.ts`) only keys the lookup;
 *  because it hydrates cached geometry against the FRESH buffer, a hit is
 *  VALIDATED by the source File's `lastModified` (mtime guard) plus a TRUE
 *  full-file hash re-checked off the main thread (see
 *  `cacheTier.decideMeshOnlyCacheHit` + `utils/sourceContentHash.ts`), so a
 *  changed source is a safe miss/reload rather than a silent chimera — with no
 *  main-thread stall on the repeat open. */
export const CACHE_MESH_ONLY_MAX_SIZE = 400 * 1024 * 1024;

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

/**
 * File size at which the browser parser worker defers indexing of property
 * atoms (`IFCPROPERTYSINGLEVALUE`, `IFCPROPERTYENUMERATEDVALUE`, etc.) until
 * a property panel actually opens.
 *
 * On a 14 M-entity, 986 MB file roughly 3.4 M of those entities are
 * property atoms. Skipping them in the primary `compactByIdIndex` shaves
 * ~4 s off the parse path; the deferred index is built on-demand in
 * ~50 ms when the first property panel hydrates. Mirrors the desktop
 * `hugeNativeMode` gate.
 */
export const HUGE_BROWSER_FILE_THRESHOLD = 500 * 1024 * 1024;

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
