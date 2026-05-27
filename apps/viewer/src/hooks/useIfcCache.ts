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
  type CachedEntityIndexColumns,
  type IfcDataStore as CacheDataStore,
  type GeometryData,
} from '@ifc-lite/cache';
import { SpatialHierarchyBuilder, StepTokenizer, CompactEntityIndex, CompactEntityIndexBuilder, extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import type { MeshData } from '@ifc-lite/geometry';

import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '../store.js';
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
  } = useViewerStore(useShallow((s) => ({
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
  })));

  /**
   * Load from binary cache - INSTANT load for maximum speed
   * Large cached models load all geometry at once for fastest total time
   */
  const loadFromCache = useCallback(async (
    cacheResult: CacheResult,
    fileName: string,
    cacheKey?: string
  ): Promise<CacheLoadResult> => {
    try {
      const cacheLoadStart = performance.now();
      setProgress({ phase: 'Loading from cache', percent: 10 });

      // Reset geometry first so Viewport detects this as a new file
      setGeometryResult(null);

      const reader = new BinaryCacheReader();
      const result = await reader.read(cacheResult.buffer);
      const cacheReadTime = performance.now() - cacheLoadStart;

      // Convert cache data store to viewer data store format
      const dataStore = result.dataStore as any;

      // Restore source buffer for on-demand property extraction
      if (cacheResult.sourceBuffer) {
        dataStore.source = new Uint8Array(cacheResult.sourceBuffer);

        if (result.entityIndex) {
          dataStore.entityIndex = buildEntityIndexFromCachedColumns(result.entityIndex);
        } else {
          // Backward compatibility for v3 caches: rebuild byte offsets from the
          // source once, then future v4 writes persist this section.
          const tokenizer = new StepTokenizer(dataStore.source);
          const estimatedCount = dataStore.entities?.count ?? 100_000;
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
          const compactByIdIndex = indexBuilder.build();
          dataStore.entityIndex = { byId: compactByIdIndex, byType };
        }

        // Rebuild on-demand maps from relationships
        // Pass entityIndex which contains ALL entity types including IfcPropertySet/IfcElementQuantity
        // (the entity table may not include these since they're filtered during fresh parse)
        const { onDemandPropertyMap, onDemandQuantityMap } = rebuildOnDemandMaps(
          dataStore.entities,
          dataStore.relationships,
          dataStore.entityIndex
        );
        dataStore.onDemandPropertyMap = onDemandPropertyMap;
        dataStore.onDemandQuantityMap = onDemandQuantityMap;
      } else {
        console.warn('[useIfcCache] No source buffer in cache - on-demand property extraction disabled');
        dataStore.source = new Uint8Array(0);
      }

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

      if (result.geometry) {
        const { meshes, coordinateInfo, totalVertices, totalTriangles } = result.geometry;

        // INSTANT: Set ALL geometry in ONE call - fastest for cached models
        setGeometryResult({
          meshes,
          totalVertices,
          totalTriangles,
          coordinateInfo,
        });

        // Set data store
        setIfcDataStore(dataStore);

        buildSpatialIndexGuarded(meshes, dataStore, setIfcDataStore);
      } else {
        setIfcDataStore(dataStore);
      }

      setProgress({ phase: 'Complete (from cache)', percent: 100 });
      const totalCacheTime = performance.now() - cacheLoadStart;
      const meshCount = result.geometry?.meshes.length || 0;
      console.log(`[useIfcCache] ✓ ${fileName} (cached) → ${meshCount} meshes | ${totalCacheTime.toFixed(0)}ms`);

      return {
        success: true,
        meshCount,
        totalVertices: result.geometry?.totalVertices || 0,
        totalTriangles: result.geometry?.totalTriangles || 0,
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
    fileName: string
  ): Promise<void> => {
    try {
      console.log('[useIfcCache] Starting cache write for:', fileName);
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

      console.log('[useIfcCache] Writing cache buffer...');
      const cacheBuffer = await writer.write(cacheDataStore, geometry, sourceBuffer, { includeGeometry: true });
      console.log('[useIfcCache] Cache buffer written:', cacheBuffer.byteLength, 'bytes');

      console.log('[useIfcCache] Saving to cache storage...');
      await setCached(cacheKey, cacheBuffer, fileName, sourceBuffer.byteLength, sourceBuffer);
      console.log('[useIfcCache] ✓ Cache saved successfully');
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
