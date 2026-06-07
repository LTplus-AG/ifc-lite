/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IfcTypeEnum,
  IfcTypeEnumToString,
  PropertyTableBuilder,
  PropertyValueType,
  QuantityTableBuilder,
  type PropertyTable,
  type QuantityTable,
  type SpatialHierarchy,
  type SpatialNode,
} from '@ifc-lite/data';
import {
  BinaryCacheReader,
  BinaryCacheWriter,
  SchemaVersion as CacheSchemaVersion,
  type IfcDataStore as CacheDataStore,
} from '@ifc-lite/cache';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { rebuildOnDemandMaps } from './spatialHierarchy.js';

interface SerializedSpatialNode {
  expressId: number;
  type: number;
  name: string;
  elevation?: number;
  children: SerializedSpatialNode[];
  elements: number[];
}

interface SerializedSpatialHierarchy {
  project: SerializedSpatialNode;
  byStorey: Array<[number, number[]]>;
  byBuilding: Array<[number, number[]]>;
  bySite: Array<[number, number[]]>;
  bySpace: Array<[number, number[]]>;
  storeyElevations: Array<[number, number]>;
  storeyHeights: Array<[number, number]>;
  elementToStorey: Array<[number, number]>;
}

interface SerializedDesktopMetadataSnapshot {
  version: number;
  schemaVersion: IfcDataStore['schemaVersion'];
  fileSize: number;
  entityCount: number;
  parseTime: number;
  spatialHierarchy: SerializedSpatialHierarchy | null;
  propertySetIds: number[];
  quantitySetIds: number[];
}

interface DecodedDesktopMetadataSnapshot {
  cacheBuffer: ArrayBuffer;
  metadata: SerializedDesktopMetadataSnapshot;
}

const SNAPSHOT_VERSION = 2;

function toCacheSchemaVersion(schemaVersion: IfcDataStore['schemaVersion']): CacheSchemaVersion {
  switch (schemaVersion) {
    case 'IFC4':
      return CacheSchemaVersion.IFC4;
    case 'IFC4X3':
      return CacheSchemaVersion.IFC4X3;
    default:
      return CacheSchemaVersion.IFC2X3;
  }
}

function serializeSpatialNode(node: SpatialNode): SerializedSpatialNode {
  return {
    expressId: node.expressId,
    type: node.type,
    name: node.name,
    elevation: node.elevation,
    children: node.children.map(serializeSpatialNode),
    elements: [...node.elements],
  };
}

function deserializeSpatialNode(node: SerializedSpatialNode): SpatialNode {
  return {
    expressId: node.expressId,
    type: node.type as IfcTypeEnum,
    name: node.name,
    elevation: node.elevation,
    children: node.children.map(deserializeSpatialNode),
    elements: [...node.elements],
  };
}

function serializeSpatialHierarchy(spatialHierarchy: SpatialHierarchy | undefined): SerializedSpatialHierarchy | null {
  if (!spatialHierarchy) return null;
  return {
    project: serializeSpatialNode(spatialHierarchy.project),
    byStorey: [...spatialHierarchy.byStorey.entries()].map(([id, elements]) => [id, [...elements]]),
    byBuilding: [...spatialHierarchy.byBuilding.entries()].map(([id, elements]) => [id, [...elements]]),
    bySite: [...spatialHierarchy.bySite.entries()].map(([id, elements]) => [id, [...elements]]),
    bySpace: [...spatialHierarchy.bySpace.entries()].map(([id, elements]) => [id, [...elements]]),
    storeyElevations: [...spatialHierarchy.storeyElevations.entries()],
    storeyHeights: [...spatialHierarchy.storeyHeights.entries()],
    elementToStorey: [...spatialHierarchy.elementToStorey.entries()],
  };
}

function deserializeSpatialHierarchy(
  serialized: SerializedSpatialHierarchy | null | undefined,
): SpatialHierarchy | undefined {
  if (!serialized) return undefined;

  const project = deserializeSpatialNode(serialized.project);
  const byStorey = new Map<number, number[]>(serialized.byStorey.map(([id, elements]) => [id, [...elements]]));
  const byBuilding = new Map<number, number[]>(serialized.byBuilding.map(([id, elements]) => [id, [...elements]]));
  const bySite = new Map<number, number[]>(serialized.bySite.map(([id, elements]) => [id, [...elements]]));
  const bySpace = new Map<number, number[]>(serialized.bySpace.map(([id, elements]) => [id, [...elements]]));
  const storeyElevations = new Map<number, number>(serialized.storeyElevations);
  const storeyHeights = new Map<number, number>(serialized.storeyHeights);
  const elementToStorey = new Map<number, number>(serialized.elementToStorey);
  const elementToSpace = new Map<number, number>();

  for (const [spaceId, elementIds] of bySpace) {
    for (const elementId of elementIds) {
      elementToSpace.set(elementId, spaceId);
    }
  }

  return {
    project,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey,
    getStoreyElements(storeyId: number): number[] {
      return byStorey.get(storeyId) ?? [];
    },
    getStoreyByElevation(z: number): number | null {
      let bestStoreyId: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [storeyId, elevation] of storeyElevations) {
        const distance = Math.abs(elevation - z);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestStoreyId = storeyId;
        }
      }
      return bestStoreyId;
    },
    getContainingSpace(elementId: number): number | null {
      return elementToSpace.get(elementId) ?? null;
    },
    getPath(elementId: number): SpatialNode[] {
      const path: SpatialNode[] = [];
      const walk = (node: SpatialNode): boolean => {
        path.push(node);
        if (node.elements.includes(elementId)) {
          return true;
        }
        for (const child of node.children) {
          if (walk(child)) {
            return true;
          }
        }
        path.pop();
        return false;
      };
      walk(project);
      return path;
    },
  };
}

function encodeSnapshotEnvelope(cacheBuffer: ArrayBuffer, metadata: SerializedDesktopMetadataSnapshot): ArrayBuffer {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const cacheBytes = new Uint8Array(cacheBuffer);
  const out = new Uint8Array(4 + metadataBytes.length + cacheBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, metadataBytes.length, true);
  out.set(metadataBytes, 4);
  out.set(cacheBytes, 4 + metadataBytes.length);
  return out.buffer;
}

function collectSnapshotIndexIds(dataStore: IfcDataStore): { propertySetIds: number[]; quantitySetIds: number[] } {
  return {
    propertySetIds: [
      ...(dataStore.entityIndex.byType.get('IFCPROPERTYSET') ?? dataStore.entityIndex.byType.get('IfcPropertySet') ?? []),
    ],
    quantitySetIds: [
      ...(dataStore.entityIndex.byType.get('IFCELEMENTQUANTITY') ?? dataStore.entityIndex.byType.get('IfcElementQuantity') ?? []),
    ],
  };
}

function buildEntityIndexByType(
  dataStore: Pick<IfcDataStore, 'entities'>,
  propertySetIds: number[],
  quantitySetIds: number[],
): Map<string, number[]> {
  const byType = new Map<string, number[]>();
  for (let i = 0; i < dataStore.entities.count; i++) {
    const typeName = IfcTypeEnumToString(dataStore.entities.typeEnum[i]).toUpperCase();
    const expressId = dataStore.entities.expressId[i];
    let ids = byType.get(typeName);
    if (!ids) {
      ids = [];
      byType.set(typeName, ids);
    }
    ids.push(expressId);
  }
  if (propertySetIds.length > 0) {
    byType.set('IFCPROPERTYSET', [...propertySetIds]);
  }
  if (quantitySetIds.length > 0) {
    byType.set('IFCELEMENTQUANTITY', [...quantitySetIds]);
  }
  return byType;
}

function decodeSnapshotEnvelope(buffer: ArrayBuffer): DecodedDesktopMetadataSnapshot {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const metadataLength = view.getUint32(0, true);
  const metadataBytes = bytes.subarray(4, 4 + metadataLength);
  const cacheBytes = bytes.subarray(4 + metadataLength);
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as SerializedDesktopMetadataSnapshot;
  return {
    cacheBuffer: cacheBytes.slice().buffer,
    metadata,
  };
}

function materializeSnapshotPropertyTable(dataStore: IfcDataStore): PropertyTable {
  if (dataStore.properties.count > 0 || !dataStore.source?.length || !dataStore.onDemandPropertyMap?.size) {
    return dataStore.properties;
  }

  const builder = new PropertyTableBuilder(dataStore.strings);
  for (const entityId of dataStore.onDemandPropertyMap.keys()) {
    const propertySets = extractPropertiesOnDemand(dataStore, entityId);
    for (const propertySet of propertySets) {
      for (const property of propertySet.properties) {
        builder.add({
          entityId,
          psetName: propertySet.name,
          psetGlobalId: propertySet.globalId ?? '',
          propName: property.name,
          propType: property.type as PropertyValueType,
          value: property.value,
        });
      }
    }
  }
  return builder.build();
}

function materializeSnapshotQuantityTable(dataStore: IfcDataStore): QuantityTable {
  if (dataStore.quantities.count > 0 || !dataStore.source?.length || !dataStore.onDemandQuantityMap?.size) {
    return dataStore.quantities;
  }

  const builder = new QuantityTableBuilder(dataStore.strings);
  for (const entityId of dataStore.onDemandQuantityMap.keys()) {
    const quantitySets = extractQuantitiesOnDemand(dataStore, entityId);
    for (const quantitySet of quantitySets) {
      for (const quantity of quantitySet.quantities) {
        builder.add({
          entityId,
          qsetName: quantitySet.name,
          quantityName: quantity.name,
          quantityType: quantity.type,
          value: quantity.value,
        });
      }
    }
  }
  return builder.build();
}

export async function buildDesktopMetadataSnapshot(
  dataStore: IfcDataStore,
  sourceBuffer: ArrayBuffer,
): Promise<ArrayBuffer> {
  const writer = new BinaryCacheWriter();
  const properties = materializeSnapshotPropertyTable(dataStore);
  const quantities = materializeSnapshotQuantityTable(dataStore);
  const cacheDataStore: CacheDataStore = {
    schema: toCacheSchemaVersion(dataStore.schemaVersion),
    entityCount: dataStore.entityCount || dataStore.entities?.count || 0,
    strings: dataStore.strings,
    entities: dataStore.entities,
    properties,
    quantities,
    relationships: dataStore.relationships,
    spatialHierarchy: dataStore.spatialHierarchy,
  };

  const cacheBuffer = await writer.write(cacheDataStore, undefined, sourceBuffer, {
    includeGeometry: false,
    includeSpatialHierarchy: false,
  });
  const { propertySetIds, quantitySetIds } = collectSnapshotIndexIds(dataStore);

  return encodeSnapshotEnvelope(cacheBuffer, {
    version: SNAPSHOT_VERSION,
    schemaVersion: dataStore.schemaVersion,
    fileSize: dataStore.fileSize,
    entityCount: dataStore.entityCount,
    parseTime: dataStore.parseTime,
    spatialHierarchy: serializeSpatialHierarchy(dataStore.spatialHierarchy),
    propertySetIds,
    quantitySetIds,
  });
}

export async function restoreDesktopMetadataSnapshot(
  snapshotBuffer: ArrayBuffer,
): Promise<IfcDataStore> {
  const { cacheBuffer, metadata } = decodeSnapshotEnvelope(snapshotBuffer);
  if (metadata.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported-desktop-metadata-snapshot:${metadata.version}`);
  }
  const reader = new BinaryCacheReader();
  const result = await reader.read(cacheBuffer, { skipGeometry: true });
  const dataStore = result.dataStore as unknown as IfcDataStore;
  const byType = buildEntityIndexByType(
    dataStore,
    metadata.propertySetIds ?? [],
    metadata.quantitySetIds ?? [],
  );

  dataStore.fileSize = metadata.fileSize;
  dataStore.schemaVersion = metadata.schemaVersion;
  dataStore.entityCount = metadata.entityCount;
  dataStore.parseTime = metadata.parseTime;
  dataStore.source = new Uint8Array(0);
  dataStore.entityIndex = {
    byId: new Map() as IfcDataStore['entityIndex']['byId'],
    byType,
  };
  dataStore.spatialHierarchy = deserializeSpatialHierarchy(metadata.spatialHierarchy);

  const { onDemandPropertyMap, onDemandQuantityMap, onDemandMaterialMap } = rebuildOnDemandMaps(
    dataStore.entities,
    dataStore.relationships,
    dataStore.entityIndex,
  );
  dataStore.onDemandPropertyMap = onDemandPropertyMap;
  dataStore.onDemandQuantityMap = onDemandQuantityMap;
  dataStore.onDemandMaterialMap = onDemandMaterialMap;

  return dataStore;
}
