/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cache service — IndexedDB-backed cache (ifc-cache.ts) for the web build.
 *
 * Extracted from useIfc.ts for reusability and testability
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result from cache lookup
 */
export interface CacheResult {
  /** Serialized cache buffer containing data store and geometry */
  buffer: ArrayBuffer;
  /** Original IFC source file for on-demand property extraction */
  sourceBuffer?: ArrayBuffer;
}

/**
 * Function signature for getting cached data
 */
export type GetCachedFn = (key: string) => Promise<CacheResult | null>;

/**
 * Function signature for setting cached data
 */
export type SetCachedFn = (
  key: string,
  data: ArrayBuffer,
  fileName: string,
  fileSize: number,
  sourceBuffer?: ArrayBuffer
) => Promise<void>;

/**
 * Function signature for deleting cached data
 */
export type DeleteCachedFn = (key: string) => Promise<void>;

/**
 * Cache service interface
 */
export interface ICacheService {
  getCached: GetCachedFn;
  setCached: SetCachedFn;
  deleteCached: DeleteCachedFn;
}

// ============================================================================
// Service Singleton
// ============================================================================

/** Cached service instance - loaded once per session */
let cacheService: ICacheService | null = null;

/**
 * Get the cache service.
 * Lazily loads the IndexedDB implementation.
 */
export async function getCacheService(): Promise<ICacheService> {
  if (cacheService) return cacheService;

  const mod = await import('./ifc-cache.js');
  cacheService = {
    getCached: mod.getCached,
    setCached: mod.setCached,
    deleteCached: mod.deleteCached,
  };

  return cacheService;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get cached data by key
 * @param key - Cache key (typically xxhash64 of source file)
 * @returns Cache result with buffer and optional source, or null if not found
 */
export async function getCached(key: string): Promise<CacheResult | null> {
  const service = await getCacheService();
  return service.getCached(key);
}

/**
 * Store data in cache
 * @param key - Cache key (typically xxhash64 of source file)
 * @param data - Serialized cache buffer
 * @param fileName - Original file name for logging
 * @param fileSize - Original file size for logging
 * @param sourceBuffer - Optional source file for on-demand extraction
 */
export async function setCached(
  key: string,
  data: ArrayBuffer,
  fileName: string,
  fileSize: number,
  sourceBuffer?: ArrayBuffer
): Promise<void> {
  const service = await getCacheService();
  return service.setCached(key, data, fileName, fileSize, sourceBuffer);
}

/**
 * Delete a cache entry by key
 * @param key - Cache key to delete
 */
export async function deleteCached(key: string): Promise<void> {
  const service = await getCacheService();
  return service.deleteCached(key);
}

/**
 * Reset the cache service singleton (useful for testing)
 */
export function resetCacheService(): void {
  cacheService = null;
}
