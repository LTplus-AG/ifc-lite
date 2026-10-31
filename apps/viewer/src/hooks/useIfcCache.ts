/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for IFC file caching operations
 * Handles loading from and saving to binary cache for fast subsequent loads
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { useCallback } from 'react';
import {
  BinaryCacheWriter,
  openGeometryChunksV13,
  toCacheDataStore,
  type CacheDataStore,
  type GeometryData,
} from '@ifc-lite/cache';
import type { IfcDataStore } from '@ifc-lite/parser';
import { decodeCachedMetadata, decodeCachedModel, readCachedInstancedShards, type DecodedCachedModel } from './ifcCacheDecode.js';
import { makeColdGeometryProvider } from '../utils/coldGeometryProvider.js';
import { getGlobalRenderer } from './useBCF.js';
import type { MeshData } from '@ifc-lite/geometry';
import { NOOP_LOAD_TRACE, type LoadTrace } from '@ifc-lite/load-trace';

import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '../store/index.js';
import { getCached, setCached, deleteCached, type CacheResult } from '../services/cacheService.js';
import { recordFirstVisible } from '../lib/perf/loadTrace.js';

/**
 * Triangles a cache hit draws as transient streaming fragments for first paint
 * (×3 indices). The rest joins its buckets and is merged and uploaded once, by
 * finalize, instead of twice (Scene.limitStreamingFragments).
 */
const CACHE_FIRST_PAINT_INDICES = 500_000 * 3;

// Re-export types for convenience
export type { CacheResult } from '../services/cacheService.js';
export { getCached, setCached, deleteCached } from '../services/cacheService.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Progress callback for cache operations
 */
export interface CacheProgress {
  phase: string;
  percent: number;
}

/**
 * Geometry result from cache
 */
export interface CacheGeometryResult {
  meshes: MeshData[];
  totalVertices: number;
  totalTriangles: number;
  coordinateInfo?: {
    originShift: { x: number; y: number; z: number };
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  };
}

export interface CacheLoadResult {
  success: boolean;
  meshCount: number;
  totalVertices: number;
  totalTriangles: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook providing cache loading and saving operations
 */
export function useIfcCache() {
  const {
    setProgress,
    setIfcDataStore,
    setGeometryResult,
    appendInstancedShards,
    appendGeometryBatch,
    setGeometryStreamingActive,
  } = useViewerStore(useShallow((s) => ({
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    appendInstancedShards: s.appendInstancedShards,
    appendGeometryBatch: s.appendGeometryBatch,
    setGeometryStreamingActive: s.setGeometryStreamingActive,
  })));

  /**
   * Load from binary cache: metadata hydrates first, then geometry STREAMS
   * chunk-by-chunk (v13 format) so first paint lands after the first chunk.
   */
  const loadFromCache = useCallback(async (
    cacheResult: CacheResult,
    fileName: string,
    // Owning model id for the restored instanced shards (#1912) — this path
    // is PRIMARY-only (a federated hit decodes via `decodeCachedModel` and
    // registers through `finalizeModel`), so its id-offset is always 0 and the
    // modelId only needs to match the model useIfcLoader.ts registers via
    // `upsertModel` for the same load.
    modelId: string,
    cacheKey?: string,
    fallbackSourceBuffer?: ArrayBufferLike,
    /**
     * Optional staleness check — returns true if this load has been
     * superseded. Same contract as `loadFromServer`'s (useIfcServer.ts:120),
     * and it exists for the same reason: an IndexedDB read is slow enough to
     * finish after a newer load has already painted, and the writes below go
     * straight into the ACTIVE model slot. Without it a superseded cache hit
     * blanks the new model's geometry and then repopulates it with the
     * previous file's.
     *
     * Optional so existing callers are unaffected; a caller that omits it
     * keeps the old behaviour.
     */
    isStale?: () => boolean,
    trace: LoadTrace = NOOP_LOAD_TRACE, // #6956: the J2 (warm open) spans land on the caller's load trace
  ): Promise<CacheLoadResult> => {
    try {
      const cacheLoadStart = performance.now();

      // Re-check before the first write — and `setProgress` below IS a write
      // into the shared (active-model) progress state, so the check has to come
      // first: `getCached` was awaited by the caller, so a newer load can
      // already own the active slot by now, and a superseded load posting
      // "Loading from cache" over the newer load's progress is visible to the
      // user even though no geometry moved.
      if (isStale?.()) {
        return { success: false, meshCount: 0, totalVertices: 0, totalTriangles: 0 };
      }

      setProgress({ phase: 'Loading from cache', percent: 10 });

      // Reset geometry first so Viewport detects this as a new file
      setGeometryResult(null);

      const { dataStore, cacheBuffer, cacheBlob, headerInfo, geometrySection } =
        await decodeCachedMetadata(cacheResult, fallbackSourceBuffer, trace);

      let meshCount = 0;
      let loadedTotalVertices = 0;
      let loadedTotalTriangles = 0;

      if (geometrySection && headerInfo.hasGeometry) {
        // v13 STREAMED path: decode + append geometry chunk-by-chunk so the
        // first chunks paint while the rest still decompress. Mirrors the
        // fresh streaming path's store contract (appendGeometryBatch under
        // geometryStreamingActive, so useGeometryStreaming finalizes the
        // fragments when the flag flips back off).
        const open = openGeometryChunksV13(
          cacheBuffer,
          geometrySection.offset,
          headerInfo.version
        );
        loadedTotalVertices = open.totalVertices;
        loadedTotalTriangles = open.totalTriangles;

        // Re-check before the streaming flag: `reader.read` above was awaited,
        // so a newer load can own the slot by now. The flag is global
        // (active-model) state — a superseded load raising it here, or lowering
        // it in the `finally` below, would drive the NEWER load's stream.
        if (isStale?.()) {
          return { success: false, meshCount: 0, totalVertices: 0, totalTriangles: 0 };
        }

        getGlobalRenderer()?.getScene().limitStreamingFragments(CACHE_FIRST_PAINT_INDICES);
        setGeometryStreamingActive(true);
        const allMeshes: MeshData[] = [];
        let superseded = false;
        let firstVisible: Promise<void> | undefined;
        try {
          for (let i = 0; i < open.chunks.length; i++) {
            const chunkMeshes = await open.readChunk(i);
            // Per-chunk re-check: every iteration awaits `readChunk` AND yields
            // to the event loop at the end of the body, so supersession can
            // land BETWEEN chunks. Without this, the remaining chunks of the
            // old file keep appending into the new model's geometry.
            if (isStale?.()) {
              superseded = true;
              break;
            }
            allMeshes.push(...chunkMeshes);
            appendGeometryBatch(modelId, chunkMeshes, open.coordinateInfo);
            if (i === 0) firstVisible = recordFirstVisible(trace, trace.milestone('geometry.firstAppend')); // every load: ifc_model_loaded reads it (#6961)
            if ((i & 3) === 3 || i === open.chunks.length - 1) {
              setProgress({
                phase: 'Loading geometry from cache',
                percent: 20 + Math.round((70 * (i + 1)) / open.chunks.length),
              });
            }
            // Yield so the animation loop drains the mesh queue between chunks (paint progresses, like a fresh stream).
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } catch (chunkErr) {
          // A corrupt/truncated entry can fail AFTER earlier chunks were
          // already appended. Roll the partial geometry back so the caller's
          // fallback fresh stream starts from a clean scene instead of
          // appending onto half a cached model. Only when we still own the
          // slot: for a superseded load the partial geometry is the NEWER
          // model's, and clearing it would blank the file the user is looking
          // at (this path's own fallback reparse is abandoned anyway).
          if (!isStale?.()) setGeometryResult(null);
          throw chunkErr;
        } finally {
          // Same ownership condition: only the load that raised the flag (and
          // still owns the slot) may lower it. A superseded load lowering it
          // ends the newer load's stream early and finalizes half a model.
          if (!isStale?.()) setGeometryStreamingActive(false);
        }

        await firstVisible; // bounded (rAF or 250 ms); ahead of the ownership re-check below
        // Re-check after the chunk loop: it awaits per chunk (and yields to the
        // event loop after each append), so a newer load can have taken the
        // active slot mid-stream — including after the LAST chunk's yield. This
        // sits ahead of the shard append, which is an active-slot write too:
        // shards from the old file would be instanced into the new model.
        if (superseded || isStale?.()) {
          return { success: false, meshCount: 0, totalVertices: 0, totalTriangles: 0 };
        }

        meshCount = allMeshes.length;
        trace.milestone('geometry.streamComplete');

        // Restore the GPU-instancing shards (opaque repeated occurrences that
        // were partitioned off the flat meshes).
        const shards = readCachedInstancedShards({ dataStore, cacheBuffer, cacheBlob, headerInfo, geometrySection });
        if (shards.length > 0) appendInstancedShards(modelId, shards);

        setIfcDataStore(dataStore);

        // Cold-storage provider (issue #1682 phase 3b): with this wired the
        // scene may drop CPU meshData for cold chunks and restore them from
        // this entry via partial reads (Blob slice when available). Primary
        // loads only — a federated add clears the provider (its geometry is
        // not in this entry, so cold restores could not serve it).
        const renderer = getGlobalRenderer();
        if (renderer) {
          renderer.getScene().setColdGeometryProvider(makeColdGeometryProvider({
            source: cacheBlob ?? cacheBuffer,
            geometrySectionOffset: geometrySection.offset,
            chunks: open.chunks,
            version: headerInfo.version,
          }));
        }
      } else {
        // The no-geometry entry bypasses BOTH guards in the geometry branch
        // above, yet it still crosses the awaited `reader.read` (and the
        // Blob `arrayBuffer()` materialization) after the entry check — so it
        // needs its own re-check before writing the store and the progress
        // line below, or a superseded metadata-only hit hands the new model the
        // previous file's entities.
        if (isStale?.()) {
          return { success: false, meshCount: 0, totalVertices: 0, totalTriangles: 0 };
        }
        setIfcDataStore(dataStore);
      }

      trace.milestone('cache.storeReady'); // #6961: spatial tree and properties are queryable from here
      setProgress({ phase: 'Complete (from cache)', percent: 100 });
      const totalCacheTime = performance.now() - cacheLoadStart;
      console.log(`[useIfcCache] ✓ ${fileName} (cached) → ${meshCount} meshes | ${totalCacheTime.toFixed(0)}ms`);

      return {
        success: true,
        meshCount,
        totalVertices: loadedTotalVertices,
        totalTriangles: loadedTotalTriangles,
      };
    } catch (err) {
      console.error('[useIfcCache] Failed to load from cache:', err);
      // Clear corrupted cache entry if we have the key
      if (cacheKey) {
        try {
          await deleteCached(cacheKey);
          console.log('[useIfcCache] Cleared corrupted cache entry:', cacheKey);
        } catch {
          // Ignore cleanup errors
        }
      }
      return {
        success: false,
        meshCount: 0,
        totalVertices: 0,
        totalTriangles: 0,
      };
    }
  }, [setProgress, setIfcDataStore, setGeometryResult]);

  /**
   * Federated cache hit: decode the whole entry off the active slot, then let
   * the caller register it (`finalizeModel`: alignment, id offset, addModel),
   * exactly like a fresh federated parse. A corrupt entry is deleted and
   * reported as a miss so the caller reparses; a registration failure is the
   * caller's and propagates.
   */
  const loadFederatedFromCache = useCallback(async (
    cacheResult: CacheResult,
    cacheKey: string,
    fallbackSourceBuffer: ArrayBufferLike,
    isStale: () => boolean,
    trace: LoadTrace,
    register: (hit: DecodedCachedModel) => Promise<void>,
  ): Promise<CacheLoadResult> => {
    const miss = { success: false, meshCount: 0, totalVertices: 0, totalTriangles: 0 };
    let hit: DecodedCachedModel | null;
    try {
      hit = await decodeCachedModel(cacheResult, fallbackSourceBuffer, trace, isStale);
    } catch (err) {
      console.error('[useIfcCache] Failed to decode federated cache entry:', err);
      await deleteCached(cacheKey).catch((deleteErr) => console.warn('[useIfcCache] cache entry cleanup failed:', deleteErr));
      return miss;
    }
    if (!hit || isStale()) return miss;
    await register(hit); // the whole model enters the scene at once: first append = stream complete
    if (isStale()) return miss;
    const appendedAt = trace.milestone('geometry.firstAppend');
    trace.milestone('geometry.streamComplete');
    await recordFirstVisible(trace, appendedAt);
    trace.milestone('cache.storeReady');
    return {
      success: true,
      meshCount: hit.geometry.meshes.length,
      totalVertices: hit.geometry.totalVertices,
      totalTriangles: hit.geometry.totalTriangles,
    };
  }, []);

  /**
   * Save parsed data and geometry to cache
   */
  const saveToCache = useCallback(async (
    cacheKey: string,
    dataStore: IfcDataStore,
    geometry: GeometryData,
    sourceBuffer: ArrayBuffer,
    fileName: string,
    options: { persistSource?: boolean; lastModified?: number; fullSourceHash?: Promise<string | undefined> } = {}
  ): Promise<void> => {
    // `persistSource` (default true) is the classic <=150MB tier: the raw source
    // is stored alongside the cache so lazy property/quantity accessors + re-export
    // read it from IndexedDB. The mesh-only tier (150-400MB) passes false: the
    // source is too big to persist, so it is omitted from IndexedDB and rehydrated
    // from the freshly read buffer on re-open.
    //
    // The header's full-file `xxhash64` is OMITTED (`omitSourceHash`) so a 400MB
    // cold-load write pays no full-file main-thread hash. The source-decoupled hit
    // is instead validated by the source File's `lastModified` (mtime guard) plus
    // a full-content SHA-256 (`fullSourceHash`: the load's own placement identity,
    // #7022, so the write never hashes the source a second time), both stored in
    // the IndexedDB record — distinct from the header hash and the key's spread
    // fingerprint. The loader re-validates a served hit against it (#4269).
    const { persistSource = true, lastModified } = options;
    try {
      console.log(`[useIfcCache] Starting cache write for: ${fileName} (persistSource=${persistSource})`);
      const writer = new BinaryCacheWriter();

      // Adapt dataStore to cache format. `toCacheDataStore` is the package's
      // own runtime→cache adapter and now the ONLY schemaVersion→SchemaVersion
      // mapping: this hook used to keep an inline copy that spelled the enum
      // out as bare 1/2/0 literals, so the two could drift apart silently.
      // It carries the same entityCount fallback the inline copy had.
      const cacheDataStore: CacheDataStore = toCacheDataStore(dataStore);

      console.log('[useIfcCache] Writing cache buffer...');
      const cacheBuffer = await writer.write(cacheDataStore, geometry, sourceBuffer, {
        includeGeometry: true, compressGeometryChunksInWorker: true,
        omitSourceHash: true,
      });
      console.log('[useIfcCache] Cache buffer written:', cacheBuffer.byteLength, 'bytes');

      // BOTH tiers (#4269): the only gate for an mtime-preserved, length-preserving edit.
      const fullSourceHash = await options.fullSourceHash;

      console.log('[useIfcCache] Saving to cache storage...');
      await setCached(
        cacheKey,
        cacheBuffer,
        fileName,
        sourceBuffer.byteLength,
        persistSource ? sourceBuffer : undefined,
        { lastModified, fullSourceHash, sourceContentKey: dataStore.source.contentKey },
      );
      console.log(`[useIfcCache] ✓ Cache saved successfully (${persistSource ? 'with' : 'without'} source, mtime=${lastModified ?? 'n/a'}, fullHash=${fullSourceHash ? 'yes' : 'no'})`);
    } catch (err) {
      console.error('[useIfcCache] Failed to cache model:', err);
      console.error('[useIfcCache] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
    }
  }, []);

  return {
    loadFromCache,
    loadFederatedFromCache,
    saveToCache,
    getCached,
    setCached,
  };
}
