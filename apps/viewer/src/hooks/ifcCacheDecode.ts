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
import { deleteCached, type CacheResult } from '../services/cacheService.js';
import { recordFirstVisible } from '../lib/perf/loadTrace.js';
import { rebuildSpatialHierarchy, rebuildOnDemandMaps, type OnDemandMaps } from '../utils/spatialHierarchy.js';
import { calculateStoreyHeights } from '../utils/localParsingUtils.js';

export function buildEntityIndexFromCachedColumns(columns: CachedEntityIndexColumns): IfcDataStore['entityIndex'] {
  const byId = new CompactEntityIndex(
    columns.ids,
    columns.byteOffsets,
    columns.byteLengths,
    columns.typeIndices,
    columns.typeNames,
  );
  return { byId, byType: groupIdsByType(columns) };
}

/**
 * `byType` from the columns: every id under its type name, in column order, types in order of
 * first appearance. Grouped by type index (one array slot per type) rather than one string-keyed
 * Map lookup per entity, which was most of the ~44 ms this took on a large model's reopen.
 */
function groupIdsByType({ ids, typeIndices, typeNames }: CachedEntityIndexColumns): Map<string, number[]> {
  const groups: number[][] = new Array(typeNames.length);
  const firstSeen: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const t = typeIndices[i];
    let group = groups[t];
    if (group === undefined) {
      group = groups[t] = [];
      firstSeen.push(t);
    }
    group.push(ids[i]);
  }
  const byType = new Map<string, number[]>();
  for (const t of firstSeen) {
    const name = typeNames[t];
    const existing = byType.get(name);
    if (existing === undefined) byType.set(name, groups[t]);
    // Two type indices with one name (not written today) must interleave in column order, as before.
    else return groupIdsByTypeName(ids, typeIndices, typeNames);
  }
  return byType;
}

function groupIdsByTypeName(ids: Uint32Array, typeIndices: Uint16Array, typeNames: string[]): Map<string, number[]> {
  const byType = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i++) {
    const type = typeNames[typeIndices[i]];
    let list = byType.get(type);
    if (!list) byType.set(type, (list = []));
    list.push(ids[i]);
  }
  return byType;
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
    /** Builds the on-demand property/quantity/material maps; absent without a source. */
    onDemandMaps?: () => OnDemandMaps;
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
  };
  if (extras.onDemandMaps) defineLazyOnDemandMaps(storeData, extras.onDemandMaps);
  return attachDataStoreAccessors(storeData);
}

const ON_DEMAND_KEYS = ['onDemandPropertyMap', 'onDemandQuantityMap', 'onDemandMaterialMap'] as const;

/**
 * The on-demand maps of a cache hit, built on first read of any of them (all three at once) instead
 * of before the load is interactive (~35 ms on a large model): only a property, quantity or
 * material read, a filter schema, a list/lens or a store transport needs them. Each key then holds
 * a plain value; assigning one replaces it as before.
 */
function defineLazyOnDemandMaps(store: IfcStoreData, build: () => OnDemandMaps): void {
  let maps: OnDemandMaps | null = null;
  const materialize = (): OnDemandMaps => {
    if (maps) return maps;
    maps = build();
    for (const key of ON_DEMAND_KEYS) Object.defineProperty(store, key, { value: maps[key], writable: true, enumerable: true, configurable: true });
    return maps;
  };
  for (const key of ON_DEMAND_KEYS) {
    Object.defineProperty(store, key, {
      get: () => materialize()[key],
      set: (value: Map<number, number[]> | undefined) => {
        materialize();
        Object.defineProperty(store, key, { value, writable: true, enumerable: true, configurable: true });
      },
      enumerable: true,
      configurable: true,
    });
  }
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
  let onDemandMaps: (() => OnDemandMaps) | undefined;

  if (sourceBuffer) {
    source = new Uint8Array(sourceBuffer);

    trace.span('cache.entityIndex', () => {
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
    });

    // Rebuild on-demand maps from relationships, on first read (see defineLazyOnDemandMaps).
    // Pass entityIndex which contains ALL entity types including IfcPropertySet/IfcElementQuantity
    // (the entity table may not include these since they're filtered during fresh parse).
    const index = entityIndex;
    onDemandMaps = () => trace.span('cache.onDemandMaps', () => rebuildOnDemandMaps(
      cacheStore.entities,
      cacheStore.relationships,
      index
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
    onDemandMaps,
  }));

  // Rebuild spatial hierarchy from cache data (cache doesn't serialize it)
  // Use SpatialHierarchyBuilder to extract elevations from source buffer
  trace.span('cache.spatial', () => {
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
  });
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
    const chunks = await Promise.all(open.chunks.map((_, i) => trace.span('cache.chunkDecode', () => open.readChunk(i), { chunk: i })));
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

export interface CacheLoadResult {
  success: boolean;
  meshCount: number;
  totalVertices: number;
  totalTriangles: number;
}

/**
 * Federated cache hit: decode the whole entry off the active slot, then let
 * the caller register it (`finalizeModel`: alignment, id offset, addModel),
 * exactly like a fresh federated parse. A corrupt entry is deleted and
 * reported as a miss so the caller reparses; a registration failure is the
 * caller's and propagates.
 */
export async function loadFederatedCacheHit(
  cacheResult: CacheResult,
  cacheKey: string,
  fallbackSourceBuffer: ArrayBufferLike,
  isStale: () => boolean,
  trace: LoadTrace,
  register: (hit: DecodedCachedModel) => Promise<void>,
): Promise<CacheLoadResult> {
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
}
