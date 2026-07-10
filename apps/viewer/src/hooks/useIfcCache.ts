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
  BinaryCacheReader,
  SchemaVersion,
  SectionType,
  openGeometryChunksV13,
  readInstancedShards,
  BufferReader,
  type CachedEntityIndexColumns,
  type CacheDataStore,
  type GeometryData,
} from '@ifc-lite/cache';
import { SpatialHierarchyBuilder, StepTokenizer, CompactEntityIndex, CompactEntityIndexBuilder, extractLengthUnitScale, attachDataStoreAccessors, type IfcDataStore, type IfcStoreData } from '@ifc-lite/parser';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import { computeFullSourceHash } from '../utils/sourceContentHash.js';
import type { MeshData } from '@ifc-lite/geometry';

import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '../store/index.js';
import { getCached, setCached, deleteCached, type CacheResult } from '../services/cacheService.js';
import { rebuildSpatialHierarchy, rebuildOnDemandMaps } from '../utils/spatialHierarchy.js';
import { calculateStoreyHeights } from '../utils/localParsingUtils.js';

// Re-export types for convenience
export type { CacheResult } from '../services/cacheService.js';
export { getCached, setCached, deleteCached } from '../services/cacheService.js';

function buildEntityIndexFromCachedColumns(columns: CachedEntityIndexColumns): IfcDataStore['entityIndex'] {
  const byId = new CompactEntityIndex(
    columns.ids,
    columns.byteOffsets,
    columns.byteLengths,
    columns.typeIndices,
    columns.typeNames,
  );
  const byType = new Map<string, number[]>();
  for (let i = 0; i < columns.ids.length; i++) {
    const type = columns.typeNames[columns.typeIndices[i]];
    let ids = byType.get(type);
    if (!ids) {
      ids = [];
      byType.set(type, ids);
    }
    ids.push(columns.ids[i]);
  }
  return { byId, byType };
}

/**
 * Build the viewer's runtime {@link IfcDataStore} from a deserialized
 * {@link CacheDataStore}. This is the typed cache→runtime adapter (#952): the
 * data tables (strings/entities/properties/quantities/relationships/
 * spatialHierarchy) are the same `@ifc-lite/data` types in both stores, so the
 * mapping is compiler-checked — there is no `as unknown as IfcDataStore` escape
 * hatch, and a future required store member becomes a compile error here instead
 * of a silent runtime crash. The only field that differs is `schema` (cache) →
 * `schemaVersion` (runtime). Lazy entity/property/quantity accessors are wired
 * via {@link attachDataStoreAccessors}; with a `source` + `entityIndex` they
 * read live, otherwise they fall back to the pre-built cache tables.
 */
/**
 * Map the cache's numeric {@link SchemaVersion} enum to the runtime store's
 * string schema union. The cache format predates IFC5 (it stores IFC2X3/IFC4/
 * IFC4X3 only), so anything else round-trips as IFC2X3 — matching the inverse
 * mapping the save path uses.
 */
function cacheSchemaToVersion(schema: SchemaVersion): IfcDataStore['schemaVersion'] {
  switch (schema) {
    case SchemaVersion.IFC4: return 'IFC4';
    case SchemaVersion.IFC4X3: return 'IFC4X3';
    default: return 'IFC2X3';
  }
}

function hydrateCacheStore(
  cacheStore: CacheDataStore,
  extras: {
    source: Uint8Array;
    fileSize: number;
    entityIndex: IfcDataStore['entityIndex'];
    onDemandPropertyMap?: Map<number, number[]>;
    onDemandQuantityMap?: Map<number, number[]>;
    onDemandMaterialMap?: Map<number, number>;
  },
): IfcDataStore {
  const storeData: IfcStoreData = {
    schemaVersion: cacheSchemaToVersion(cacheStore.schema),
    entityCount: cacheStore.entityCount,
    fileSize: extras.fileSize,
    parseTime: 0,
    source: extras.source,
    strings: cacheStore.strings,
    entities: cacheStore.entities,
    properties: cacheStore.properties,
    quantities: cacheStore.quantities,
    relationships: cacheStore.relationships,
    entityIndex: extras.entityIndex,
    spatialHierarchy: cacheStore.spatialHierarchy,
    onDemandPropertyMap: extras.onDemandPropertyMap,
    onDemandQuantityMap: extras.onDemandQuantityMap,
    onDemandMaterialMap: extras.onDemandMaterialMap,
  };
  return attachDataStoreAccessors(storeData);
}

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
   * Load from binary cache - INSTANT load for maximum speed
   * Large cached models load all geometry at once for fastest total time
   */
  const loadFromCache = useCallback(async (
    cacheResult: CacheResult,
    fileName: string,
    cacheKey?: string,
    fallbackSourceBuffer?: ArrayBufferLike,
  ): Promise<CacheLoadResult> => {
    try {
      const cacheLoadStart = performance.now();
      setProgress({ phase: 'Loading from cache', percent: 10 });

      // Reset geometry first so Viewport detects this as a new file
      setGeometryResult(null);

      const reader = new BinaryCacheReader();

      // No full-file hash on the repeat-open path (the #1 un-flag blocker). The
      // hit is already validated by the strengthened, spread-sampled cache key
      // (`sourceFingerprint.ts`): a key match means the exact byte length AND a
      // 64-bit hash of a ~160KB spread (head + tail + interior windows) match, so
      // a genuinely different file can never key the same entry. That makes the
      // former ~0.7-1.7s `xxhash64(fullSource)` recompute here redundant, and
      // dropping it removes the main-thread stall for BOTH cache tiers. A
      // truncated/corrupt cache buffer still fails fast in `reader.read` below →
      // the catch deletes the entry and returns a graceful miss.
      // v13+ entries stream their geometry chunk-by-chunk below (first paint
      // after the FIRST chunk instead of a full deserialize) — read metadata
      // only here. Older entries keep the legacy one-shot geometry read.
      const headerInfo = reader.readHeader(cacheResult.buffer);
      const geometrySection = headerInfo.version >= 13
        ? headerInfo.sections.find((s) => s.type === SectionType.Geometry)
        : undefined;
      const result = await reader.read(
        cacheResult.buffer,
        geometrySection ? { skipGeometry: true } : {}
      );
      const cacheReadTime = performance.now() - cacheLoadStart;

      // Restore the source buffer — required for on-demand property extraction
      // AND the lazy entity accessors (getEntity/getProperties/...). The web
      // cache persists `sourceBuffer`; fall back to the freshly read file buffer
      // when the caller provides it. Without a source the accessors return empty
      // (and getProperties falls back to the pre-built cache tables).
      const cacheStore = result.dataStore;
      const sourceBuffer = cacheResult.sourceBuffer ?? fallbackSourceBuffer;
      let source: Uint8Array = new Uint8Array(0);
      let entityIndex: IfcDataStore['entityIndex'] = { byId: new Map(), byType: new Map() };
      let onDemandPropertyMap: Map<number, number[]> | undefined;
      let onDemandQuantityMap: Map<number, number[]> | undefined;
      let onDemandMaterialMap: Map<number, number> | undefined;

      if (sourceBuffer) {
        source = new Uint8Array(sourceBuffer);

        if (result.entityIndex) {
          entityIndex = buildEntityIndexFromCachedColumns(result.entityIndex);
        } else {
          // Backward compatibility for v3 caches: rebuild byte offsets from the
          // source once, then future v4 writes persist this section.
          const tokenizer = new StepTokenizer(source);
          const estimatedCount = cacheStore.entities?.count ?? 100_000;
          const indexBuilder = new CompactEntityIndexBuilder(estimatedCount);
          const byType = new Map<string, number[]>();

          for (const ref of tokenizer.scanEntitiesFast()) {
            indexBuilder.add(ref.expressId, ref.type, ref.offset, ref.length);
            let typeList = byType.get(ref.type);
            if (!typeList) {
              typeList = [];
              byType.set(ref.type, typeList);
            }
            typeList.push(ref.expressId);
          }
          entityIndex = { byId: indexBuilder.build(), byType };
        }

        // Rebuild on-demand maps from relationships.
        // Pass entityIndex which contains ALL entity types including IfcPropertySet/IfcElementQuantity
        // (the entity table may not include these since they're filtered during fresh parse).
        ({ onDemandPropertyMap, onDemandQuantityMap, onDemandMaterialMap } = rebuildOnDemandMaps(
          cacheStore.entities,
          cacheStore.relationships,
          entityIndex
        ));
      } else {
        console.warn('[useIfcCache] No source buffer in cache - on-demand property extraction disabled');
      }

      // Typed cache→runtime hydration (#952): builds the parser-shaped
      // IfcDataStore with compiler-checked field mapping (no `as unknown` cast)
      // and wires the lazy accessors via attachDataStoreAccessors.
      const dataStore = hydrateCacheStore(cacheStore, {
        source,
        fileSize: sourceBuffer?.byteLength ?? 0,
        entityIndex,
        onDemandPropertyMap,
        onDemandQuantityMap,
        onDemandMaterialMap,
      });

      // Rebuild spatial hierarchy from cache data (cache doesn't serialize it)
      // Use SpatialHierarchyBuilder to extract elevations from source buffer
      if (!dataStore.spatialHierarchy && dataStore.entities && dataStore.relationships) {
        // Ensure we have source buffer and entityIndex for elevation extraction
        if (dataStore.source && dataStore.source.length > 0 && dataStore.entityIndex && dataStore.strings) {
          const lengthUnitScale = extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
          const builder = new SpatialHierarchyBuilder();
          dataStore.spatialHierarchy = builder.build(
            dataStore.entities,
            dataStore.relationships,
            dataStore.strings,
            dataStore.source,
            dataStore.entityIndex,
            lengthUnitScale
          );

          // Calculate storey heights from elevation differences (fallback if no property data)
          if (dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
            const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
            for (const [storeyId, height] of calculatedHeights) {
              dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
            }
          }
        } else {
          console.warn('[useIfcCache] Missing data for elevation extraction:', {
            hasSource: !!dataStore.source,
            sourceLength: dataStore.source?.length ?? 0,
            hasEntityIndex: !!dataStore.entityIndex,
            hasStrings: !!dataStore.strings,
          });
          // Fallback: use simplified rebuild if source data not available
          dataStore.spatialHierarchy = rebuildSpatialHierarchy(
            dataStore.entities,
            dataStore.relationships
          );
        }
      }

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
          cacheResult.buffer,
          geometrySection.offset,
          headerInfo.version
        );
        loadedTotalVertices = open.totalVertices;
        loadedTotalTriangles = open.totalTriangles;

        setGeometryStreamingActive(true);
        const allMeshes: MeshData[] = [];
        try {
          for (let i = 0; i < open.chunks.length; i++) {
            const chunkMeshes = await open.readChunk(i);
            allMeshes.push(...chunkMeshes);
            appendGeometryBatch(chunkMeshes, open.coordinateInfo);
            if ((i & 3) === 3 || i === open.chunks.length - 1) {
              setProgress({
                phase: 'Loading geometry from cache',
                percent: 20 + Math.round((70 * (i + 1)) / open.chunks.length),
              });
            }
            // Yield so the animation loop can drain the mesh queue between
            // chunks (paint progresses during the load, like a fresh stream).
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } catch (chunkErr) {
          // A corrupt/truncated entry can fail AFTER earlier chunks were
          // already appended. Roll the partial geometry back so the caller's
          // fallback fresh stream starts from a clean scene instead of
          // appending onto half a cached model.
          setGeometryResult(null);
          throw chunkErr;
        } finally {
          setGeometryStreamingActive(false);
        }
        meshCount = allMeshes.length;

        // Restore the GPU-instancing shards (opaque repeated occurrences that
        // were partitioned off the flat meshes).
        const shardsSection = headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
        if (shardsSection) {
          const shardsReader = new BufferReader(cacheResult.buffer);
          shardsReader.position = shardsSection.offset;
          const shards = readInstancedShards(shardsReader);
          if (shards.length > 0) appendInstancedShards(shards);
        }

        setIfcDataStore(dataStore);
        buildSpatialIndexGuarded(allMeshes, dataStore, setIfcDataStore);
      } else if (result.geometry) {
        const { meshes, coordinateInfo, totalVertices, totalTriangles } = result.geometry;
        meshCount = meshes.length;
        loadedTotalVertices = totalVertices;
        loadedTotalTriangles = totalTriangles;

        // Legacy (pre-v13) entries: set ALL geometry in ONE call.
        setGeometryResult({
          meshes,
          totalVertices,
          totalTriangles,
          coordinateInfo,
        });

        // Restore the GPU-instancing shards (opaque repeated occurrences that were
        // partitioned off the flat meshes). useGeometryStreaming drains these →
        // decodeInstancedShard → scene.addInstancedShard, exactly like a fresh load,
        // so cached instanced geometry renders + picks + exports correctly.
        if (result.geometry.instancedShards && result.geometry.instancedShards.length > 0) {
          appendInstancedShards(result.geometry.instancedShards);
        }

        // Set data store
        setIfcDataStore(dataStore);

        buildSpatialIndexGuarded(meshes, dataStore, setIfcDataStore);
      } else {
        setIfcDataStore(dataStore);
      }

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
   * Save parsed data and geometry to cache
   */
  const saveToCache = useCallback(async (
    cacheKey: string,
    dataStore: IfcDataStore,
    geometry: GeometryData,
    sourceBuffer: ArrayBuffer,
    fileName: string,
    options: { persistSource?: boolean; lastModified?: number } = {}
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
    // a TRUE full-file SHA-256 computed OFF the main thread (`computeFullSourceHash`,
    // via Web Crypto), both stored in the IndexedDB record — distinct from the
    // header hash and the key's spread fingerprint. This whole block is
    // backgrounded on a cold load, so the off-thread hash costs the user nothing.
    const { persistSource = true, lastModified } = options;
    try {
      console.log(`[useIfcCache] Starting cache write for: ${fileName} (persistSource=${persistSource})`);
      const writer = new BinaryCacheWriter();

      // Adapt dataStore to cache format
      const cacheDataStore: CacheDataStore = {
        schema: dataStore.schemaVersion === 'IFC4' ? 1 : dataStore.schemaVersion === 'IFC4X3' ? 2 : 0,
        entityCount: dataStore.entityCount || dataStore.entities?.count || 0,
        strings: dataStore.strings,
        entities: dataStore.entities,
        properties: dataStore.properties,
        quantities: dataStore.quantities,
        relationships: dataStore.relationships,
        spatialHierarchy: dataStore.spatialHierarchy,
        entityIndex: dataStore.entityIndex,
      };

      // Compute the true full-file validation hash off the main thread (runs in
      // parallel with the cache-buffer serialization below). ONLY for the
      // source-decoupled tier: the source-persisting tier serves cached geometry
      // AND cached source together (self-consistent) and never consults it, so
      // its <=150MB write path stays exactly as it was.
      const fullHashPromise = persistSource
        ? Promise.resolve<string | null>(null)
        : computeFullSourceHash(sourceBuffer);

      console.log('[useIfcCache] Writing cache buffer...');
      const cacheBuffer = await writer.write(cacheDataStore, geometry, sourceBuffer, {
        includeGeometry: true,
        omitSourceHash: true,
      });
      console.log('[useIfcCache] Cache buffer written:', cacheBuffer.byteLength, 'bytes');

      const fullSourceHash = (await fullHashPromise) ?? undefined;

      console.log('[useIfcCache] Saving to cache storage...');
      await setCached(
        cacheKey,
        cacheBuffer,
        fileName,
        sourceBuffer.byteLength,
        persistSource ? sourceBuffer : undefined,
        { lastModified, fullSourceHash },
      );
      console.log(`[useIfcCache] ✓ Cache saved successfully (${persistSource ? 'with' : 'without'} source, mtime=${lastModified ?? 'n/a'}, fullHash=${fullSourceHash ? 'yes' : 'no'})`);
    } catch (err) {
      console.error('[useIfcCache] Failed to cache model:', err);
      console.error('[useIfcCache] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
    }
  }, []);

  return {
    loadFromCache,
    saveToCache,
    getCached,
    setCached,
  };
}
