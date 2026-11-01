/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cache entry → runtime objects, with no store writes. The primary hit
 * (`useIfcCache.loadFromCache`) streams the decoded geometry into the active
 * slot; a federated hit decodes the whole entry here and hands the result to
 * the loader's canonical `finalizeModel`, exactly like a fresh federated parse.
 */

import {
  BinaryCacheReader,
  SchemaVersion,
  SectionType,
  openGeometryChunksV13,
  readInstancedShards,
  BufferReader,
  type CachedEntityIndexColumns,
  type CacheDataStore,
} from '@ifc-lite/cache';
import {
  contiguousSourceBytes,
  SpatialHierarchyBuilder,
  StepTokenizer,
  CompactEntityIndex,
  CompactEntityIndexBuilder,
  extractLengthUnitScale,
  attachDataStoreAccessors,
  type IfcDataStore,
  type IfcStoreData,
} from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';
import type { CacheResult } from '../services/cacheService.js';
import { rebuildSpatialHierarchy, rebuildOnDemandMaps } from '../utils/spatialHierarchy.js';
import { calculateStoreyHeights } from '../utils/localParsingUtils.js';

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
function hydrateCacheStore(
  cacheStore: CacheDataStore,
  extras: {
    source: Uint8Array;
    contentKey?: string;
    fileSize: number;
    entityIndex: IfcDataStore['entityIndex'];
    onDemandPropertyMap?: Map<number, number[]>;
    onDemandQuantityMap?: Map<number, number[]>;
    onDemandMaterialMap?: Map<number, number[]>;
  },
): IfcDataStore {
  const storeData: IfcStoreData = {
    schemaVersion: cacheSchemaToVersion(cacheStore.schema),
    entityCount: cacheStore.entityCount,
    fileSize: extras.fileSize,
    parseTime: 0,
    // Seeded with the key stored at write: the lazy fallback FNV-hashes the
    // whole source on the main thread (~0.6 s at 343 MB) the first time a
    // symbolic-annotation lookup asks for it.
    source: contiguousSourceBytes(extras.source, extras.contentKey),
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

export interface DecodedCacheMetadata {
  dataStore: IfcDataStore;
  /** The materialized entry; geometry chunks are read from it. */
  cacheBuffer: ArrayBuffer;
  /** Disk-backed handle for cold-tier partial reads, when the entry is a Blob. */
  cacheBlob: Blob | null;
  headerInfo: ReturnType<BinaryCacheReader['readHeader']>;
  geometrySection: ReturnType<BinaryCacheReader['readHeader']>['sections'][number] | undefined;
}

/**
 * Materialize a cache entry and hydrate its data model (tables, entity index,
 * on-demand maps, spatial hierarchy). No geometry, no store writes.
 *
 * No SYNCHRONOUS full-file hash here (the former ~0.7-1.7s `xxhash64(fullSource)`
 * main-thread stall): the spread-sampled key only KEYS the lookup; staleness is
 * gated by the mtime guard + off-thread full-hash revalidation in
 * `cacheTier.ts` / `useIfcLoader` (#4269). A truncated/corrupt entry throws in
 * `reader.read`; the caller deletes it and falls back to a fresh parse.
 */
export async function decodeCachedMetadata(
  cacheResult: CacheResult,
  fallbackSourceBuffer: ArrayBufferLike | undefined,
  trace: LoadTrace,
): Promise<DecodedCacheMetadata> {
  const reader = new BinaryCacheReader();
  // Blob entries (cold-tier writes) are disk-backed: materialize once for the
  // load, but KEEP the blob handle — the cold-storage provider uses slice()
  // for partial chunk reads later (issue #1682 phase 3b).
  const rawCacheBuffer = cacheResult.buffer;
  const cacheBlob = rawCacheBuffer instanceof Blob ? rawCacheBuffer : null;
  const cacheBuffer: ArrayBuffer = rawCacheBuffer instanceof Blob
    ? await trace.span('cache.read', () => rawCacheBuffer.arrayBuffer())
    : rawCacheBuffer;

  // Geometry is read separately (chunk by chunk); the reader here loads
  // metadata only. Every hit is v13+ by construction: the cache key embeds
  // FORMAT_VERSION, so older entries can never key a hit.
  const headerInfo = reader.readHeader(cacheBuffer);
  if (headerInfo.version < 13) {
    // Impossible via the keyed lookup; fail loudly so the caller deletes the
    // entry and the load falls back to a fresh parse.
    throw new Error(`unexpected pre-v13 cache entry (v${headerInfo.version})`);
  }
  const geometrySection = headerInfo.sections.find((s) => s.type === SectionType.Geometry);
  const result = await trace.span('cache.decode', () => reader.read(cacheBuffer, { skipGeometry: true }));

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
  let onDemandMaterialMap: Map<number, number[]> | undefined;

  if (sourceBuffer) {
    source = new Uint8Array(sourceBuffer);

    if (result.entityIndex) {
      entityIndex = buildEntityIndexFromCachedColumns(result.entityIndex);
    } else {
      // Backward compatibility for v3 caches: rebuild byte offsets from the
      // source once, then future v4 writes persist this section.
      // Key `byType` in upper case, as a fresh parse and a v4 load do: not
      // every scan path canonicalises type names (#4712).
      const tokenizer = new StepTokenizer(source);
      // @raw-entity-enumeration-ok cache hydration sizes a source-index builder from the cached parsed table
      const estimatedCount = cacheStore.entities?.count ?? 100_000;
      const indexBuilder = new CompactEntityIndexBuilder(estimatedCount);
      const byType = new Map<string, number[]>();

      for (const ref of tokenizer.scanEntitiesFast()) {
        indexBuilder.add(ref.expressId, ref.type, ref.offset, ref.length);
        const typeKey = ref.type.toUpperCase();
        let typeList = byType.get(typeKey);
        if (!typeList) {
          typeList = [];
          byType.set(typeKey, typeList);
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
  const dataStore = trace.span('cache.hydrate', () => hydrateCacheStore(cacheStore, {
    source,
    contentKey: cacheResult.sourceContentKey,
    fileSize: sourceBuffer?.byteLength ?? 0,
    entityIndex,
    onDemandPropertyMap,
    onDemandQuantityMap,
    onDemandMaterialMap,
  }));

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
      console.warn('[useIfcCache] Missing data for elevation extraction:', { hasSource: !!dataStore.source, sourceLength: dataStore.source?.length ?? 0, hasEntityIndex: !!dataStore.entityIndex, hasStrings: !!dataStore.strings });
      // Fallback: use simplified rebuild if source data not available
      dataStore.spatialHierarchy = rebuildSpatialHierarchy(
        dataStore.entities,
        dataStore.relationships
      );
    }
  }

  return { dataStore, cacheBuffer, cacheBlob, headerInfo, geometrySection };
}

/** The instancing shards persisted beside the flat meshes, or none. */
export function readCachedInstancedShards(decoded: DecodedCacheMetadata): ArrayBuffer[] {
  const shardsSection = decoded.headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
  if (!shardsSection) return [];
  const shardsReader = new BufferReader(decoded.cacheBuffer);
  shardsReader.position = shardsSection.offset;
  return readInstancedShards(shardsReader);
}

export interface DecodedCachedModel {
  dataStore: IfcDataStore;
  geometry: GeometryResult;
  instancedShards: ArrayBuffer[];
}

/**
 * Decode a whole cache entry for a FEDERATED hit: the model is registered by
 * `finalizeModel` (alignment, id offset, addModel) once complete, exactly as a
 * fresh federated parse is, so nothing here touches the active slot.
 * Returns null when the entry has no geometry (the caller reparses).
 */
export async function decodeCachedModel(
  cacheResult: CacheResult,
  fallbackSourceBuffer: ArrayBufferLike | undefined,
  trace: LoadTrace,
  isStale: () => boolean,
): Promise<DecodedCachedModel | null> {
  const decoded = await decodeCachedMetadata(cacheResult, fallbackSourceBuffer, trace);
  const { geometrySection, headerInfo, cacheBuffer } = decoded;
  if (!geometrySection || !headerInfo.hasGeometry || isStale()) return null;
  const open = openGeometryChunksV13(cacheBuffer, geometrySection.offset, headerInfo.version);
  const meshes: MeshData[] = [];
  await trace.span('cache.geometry', async () => {
    // Chunks decompress independently; overlap them instead of one at a time.
    const chunks = await Promise.all(open.chunks.map((_, i) => open.readChunk(i)));
    for (const chunk of chunks) for (const mesh of chunk) meshes.push(mesh);
  });
  if (isStale()) return null;
  return {
    dataStore: decoded.dataStore,
    geometry: {
      meshes,
      totalVertices: open.totalVertices,
      totalTriangles: open.totalTriangles,
      coordinateInfo: open.coordinateInfo,
    },
    instancedShards: readCachedInstancedShards(decoded),
  };
}
