/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server data model to viewer data store conversion utilities
 * Extracted from useIfc.ts loadFromServer function
 *
 * Converts the server's data model format (from @ifc-lite/server-client)
 * to the viewer's IfcDataStore format used by the property panel and other features.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { DataModel } from '@ifc-lite/server-client';
import type { IfcDataStore } from '@ifc-lite/parser';
import { REL_TYPE_MAP as CANONICAL_REL_TYPE_MAP } from '@ifc-lite/parser';
import {
  IfcTypeEnum,
  RelationshipType,
  IfcTypeEnumFromString,
  IfcTypeEnumToString,
  EntityFlags,
  PropertyValueType,
  QuantityType,
  isBuildingLikeSpatialType,
  isStoreyLikeSpatialType,
  type SpatialHierarchy,
  type SpatialNode,
  type EntityTable,
  type RelationshipGraph,
  type PropertyTable,
  type PropertySet,
  type PropertyValue,
  type QuantityTable,
  type QuantitySet,
} from '@ifc-lite/data';
import { StringTable } from '@ifc-lite/data';
import type { SpatialIndex } from '@ifc-lite/spatial';

// ============================================================================
// Types
// ============================================================================

/**
 * Server quantity set format
 */
export interface ServerQuantitySet {
  qset_id: number;
  qset_name: string;
  method_of_measurement?: string;
  quantities: Array<{
    quantity_name: string;
    quantity_value: number;
    quantity_type: string;
  }>;
}

/**
 * Server parse result metadata (used for convertServerDataModel)
 * Note: meshes are passed separately as they're already converted to viewer format
 */
export interface ServerParseResult {
  cache_key: string;
  metadata: {
    schema_version: string;
    coordinate_info?: {
      origin_shift?: [number, number, number];
      is_geo_referenced?: boolean;
    };
  };
  stats: {
    total_time_ms: number;
    parse_time_ms: number;
    geometry_time_ms: number;
    total_vertices: number;
    total_triangles: number;
  };
}

// ============================================================================
// Spatial Hierarchy Building
// ============================================================================

/** Server spatial node shape (mirrors SpatialNode from @ifc-lite/server-client) */
interface ServerSpatialNode {
  entity_id: number;
  parent_id: number;
  level: number;
  path: string;
  type_name: string;
  name?: string;
  elevation?: number;
  children_ids: number[];
  element_ids: number[];
}

/** Maximum recursion depth for spatial tree building */
const MAX_SPATIAL_TREE_DEPTH = 100;

/**
 * Build recursive SpatialNode tree from server data
 *
 * @param nodeId - Entity ID of the spatial node to build
 * @param nodesMap - Map of all spatial nodes by entity ID
 * @param depth - Current recursion depth (default 0)
 * @param visited - Set of visited node IDs for cycle detection
 */
function buildSpatialNodeTree(
  nodeId: number,
  nodesMap: Map<number, ServerSpatialNode>,
  depth: number = 0,
  visited: Set<number> = new Set()
): SpatialNode {
  // Guard against excessive depth
  if (depth > MAX_SPATIAL_TREE_DEPTH) {
    throw new Error(`Spatial tree max depth (${MAX_SPATIAL_TREE_DEPTH}) exceeded at node ${nodeId}`);
  }

  // Guard against cycles
  if (visited.has(nodeId)) {
    throw new Error(`Cycle detected in spatial tree at node ${nodeId}`);
  }

  const node = nodesMap.get(nodeId);
  if (!node) {
    throw new Error(`Spatial node ${nodeId} not found`);
  }

  // Add current node to visited set
  visited.add(nodeId);

  const typeEnum = IfcTypeEnumFromString(node.type_name);

  const result: SpatialNode = {
    expressId: node.entity_id,
    type: typeEnum,
    name: node.name || node.type_name,
    elevation: node.elevation,
    children: node.children_ids.map((childId: number) =>
      buildSpatialNodeTree(childId, nodesMap, depth + 1, visited)
    ),
    elements: node.element_ids,
  };

  // Remove from visited after processing (allows node in different branches)
  visited.delete(nodeId);

  return result;
}

/**
 * Build spatial hierarchy from server data model
 */
function buildSpatialHierarchy(
  dataModel: DataModel,
  entityToPsets: Map<number, Array<{ pset_name: string; properties: Array<{ property_name: string; property_value: string | number | boolean | null }> }>>
): SpatialHierarchy {
  const byStorey = new Map<number, number[]>();
  const byBuilding = new Map<number, number[]>();
  const bySite = new Map<number, number[]>();
  const bySpace = new Map<number, number[]>();
  const storeyElevations = new Map<number, number>();
  const storeyHeights = new Map<number, number>();

  const nodesMap = new Map<number, ServerSpatialNode>(
    dataModel.spatialHierarchy.nodes.map((n: ServerSpatialNode) => [n.entity_id, n])
  );

  // Build lookup maps from spatial hierarchy data
  for (const node of dataModel.spatialHierarchy.nodes) {
    const typeEnum = IfcTypeEnumFromString(node.type_name);
    if (isStoreyLikeSpatialType(typeEnum)) {
      byStorey.set(node.entity_id, node.element_ids);
      if (node.elevation !== undefined) {
        storeyElevations.set(node.entity_id, node.elevation);
      }
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      byBuilding.set(node.entity_id, node.element_ids);
    } else if (typeEnum === IfcTypeEnum.IfcSite) {
      bySite.set(node.entity_id, node.element_ids);
    } else if (typeEnum === IfcTypeEnum.IfcSpace) {
      bySpace.set(node.entity_id, node.element_ids);
    }
  }

  // Extract storey heights from property sets
  for (const storeyId of byStorey.keys()) {
    const psets = entityToPsets.get(storeyId);
    if (!psets) continue;
    for (const pset of psets) {
      for (const prop of pset.properties) {
        const propName = prop.property_name.toLowerCase();
        if (propName === 'grossheight' || propName === 'netheight' || propName === 'height') {
          const val = typeof prop.property_value === 'number' ? prop.property_value : parseFloat(String(prop.property_value));
          if (!isNaN(val) && val > 0) {
            storeyHeights.set(storeyId, val);
            break;
          }
        }
      }
      if (storeyHeights.has(storeyId)) break;
    }
  }

  // Fallback: calculate heights from elevation differences
  if (storeyHeights.size === 0 && storeyElevations.size > 1) {
    const sortedStoreys = Array.from(storeyElevations.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sortedStoreys.length - 1; i++) {
      const [storeyId, elevation] = sortedStoreys[i];
      const nextElevation = sortedStoreys[i + 1][1];
      const height = nextElevation - elevation;
      if (height > 0) {
        storeyHeights.set(storeyId, height);
      }
    }
    console.log(`[serverDataModel] Calculated ${storeyHeights.size} storey heights from elevation differences`);
  }

  // Build project node tree
  const projectNode = buildSpatialNodeTree(dataModel.spatialHierarchy.project_id, nodesMap);

  const findPath = (node: SpatialNode, targetId: number, path: SpatialNode[] = []): SpatialNode[] => {
    const nextPath = [...path, node];
    if (node.elements.includes(targetId)) {
      return nextPath;
    }
    for (const child of node.children) {
      const childPath = findPath(child, targetId, nextPath);
      if (childPath.length > 0) {
        return childPath;
      }
    }
    return [];
  };

  return {
    project: projectNode,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey: dataModel.spatialHierarchy.element_to_storey,
    getStoreyElements: (storeyId: number) => byStorey.get(storeyId) || [],
    getStoreyByElevation: (z: number) => {
      let closest: [number, number] | null = null;
      for (const [storeyId, elev] of storeyElevations) {
        const diff = Math.abs(elev - z);
        if (!closest || diff < closest[1]) {
          closest = [storeyId, diff];
        }
      }
      return closest ? closest[0] : null;
    },
    getContainingSpace: (elementId: number) => {
      return dataModel.spatialHierarchy.element_to_space.get(elementId) || null;
    },
    getPath: (elementId: number) => {
      return findPath(projectNode, elementId);
    },
  };
}

// ============================================================================
// Entity Table Building
// ============================================================================

/**
 * Build EntityTable from server data model
 */
function buildEntityTable(
  dataModel: DataModel,
  strings: StringTable
): { entities: EntityTable; entityByIdMap: Map<number, any>; typeGroups: Map<IfcTypeEnum, number[]> } {
  const entityCount = dataModel.entities.size;

  // Pre-allocate TypedArrays
  const expressId = new Uint32Array(entityCount);
  const typeEnumArr = new Uint16Array(entityCount);
  const globalIdArr = new Uint32Array(entityCount);
  const nameArr = new Uint32Array(entityCount);
  const descriptionArr = new Uint32Array(entityCount);
  const objectTypeArr = new Uint32Array(entityCount);
  const flagsArr = new Uint8Array(entityCount);
  const containedInStoreyArr = new Int32Array(entityCount).fill(-1);
  const definedByTypeArr = new Int32Array(entityCount).fill(-1);
  const geometryIndexArr = new Int32Array(entityCount).fill(-1);

  // Maps for fast lookup
  const idToIndex = new Map<number, number>();
  const globalIdToExpressId = new Map<string, number>();
  const entityByIdMap = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const typeGroups = new Map<IfcTypeEnum, number[]>();

  // Single pass through entities
  let idx = 0;
  for (const [id, entity] of dataModel.entities) {
    idToIndex.set(id, idx);
    expressId[idx] = id;
    const typeVal = IfcTypeEnumFromString(entity.type_name);
    typeEnumArr[idx] = typeVal;
    const globalIdString = entity.global_id || '';
    globalIdArr[idx] = strings.intern(globalIdString);
    if (globalIdString) {
      globalIdToExpressId.set(globalIdString, id);
    }
    nameArr[idx] = strings.intern(entity.name || '');
    descriptionArr[idx] = strings.intern((entity as { description?: string }).description || '');
    objectTypeArr[idx] = strings.intern((entity as { object_type?: string }).object_type || '');
    flagsArr[idx] = entity.has_geometry ? EntityFlags.HAS_GEOMETRY : 0;

    entityByIdMap.set(id, {
      expressId: id,
      type: entity.type_name,
      byteOffset: 0,
      byteLength: 0,
      lineNumber: 0,
    });

    if (!typeGroups.has(typeVal)) {
      typeGroups.set(typeVal, []);
    }
    typeGroups.get(typeVal)!.push(idx);
    idx++;
  }

  const indexOfId = (id: number): number => idToIndex.get(id) ?? -1;

  const entities: EntityTable = {
    count: entityCount,
    expressId,
    typeEnum: typeEnumArr,
    globalId: globalIdArr,
    name: nameArr,
    description: descriptionArr,
    objectType: objectTypeArr,
    flags: flagsArr,
    containedInStorey: containedInStoreyArr,
    definedByType: definedByTypeArr,
    geometryIndex: geometryIndexArr,
    typeRanges: new Map(), // Deprecated - use getByType which uses typeGroups directly
    getGlobalId: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? strings.get(globalIdArr[i]) : '';
    },
    getName: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? strings.get(nameArr[i]) : '';
    },
    getDescription: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? strings.get(descriptionArr[i]) : '';
    },
    getObjectType: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? strings.get(objectTypeArr[i]) : '';
    },
    getTypeName: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? IfcTypeEnumToString(typeEnumArr[i]) : 'Unknown';
    },
    hasGeometry: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? (flagsArr[i] & EntityFlags.HAS_GEOMETRY) !== 0 : false;
    },
    getByType: (type) => {
      // Use typeGroups directly - indices stored there map to expressId array
      const indices = typeGroups.get(type);
      if (!indices) return [];
      return indices.map(idx => expressId[idx]);
    },
    getTypeEnum: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? typeEnumArr[i] as IfcTypeEnum : IfcTypeEnum.Unknown;
    },
    getExpressIdByGlobalId: (gid) => {
      return globalIdToExpressId.get(gid) ?? -1;
    },
    getGlobalIdMap: () => {
      return new Map(globalIdToExpressId); // Defensive copy
    },
  };

  return { entities, entityByIdMap, typeGroups };
}

// ============================================================================
// Relationship Graph Building
// ============================================================================

/**
 * Build RelationshipGraph and property/quantity mappings from server data model
 */
function buildRelationships(
  dataModel: DataModel
): {
  relationships: RelationshipGraph;
  entityToPsets: Map<number, Array<any>>;
  entityToQsets: Map<number, Array<ServerQuantitySet>>;
} {
  const forwardEdges = new Map<number, Array<{ target: number; type: RelationshipType; relationshipId: number }>>();
  const inverseEdges = new Map<number, Array<{ target: number; type: RelationshipType; relationshipId: number }>>();
  const entityToPsets = new Map<number, Array<any>>();
  const entityToQsets = new Map<number, Array<ServerQuantitySet>>();
  const unmappedRelTypes = new Set<string>();

  // Combined loop - process relationships once for both graph building AND property mapping
  for (const rel of dataModel.relationships) {
    const upperType = rel.rel_type.toUpperCase();
    const relType = CANONICAL_REL_TYPE_MAP[upperType];

    // Build property set and quantity set mappings (regardless of relType mapping)
    if (upperType === 'IFCRELDEFINESBYPROPERTIES') {
      const pset = dataModel.propertySets.get(rel.relating_id);
      if (pset) {
        if (!entityToPsets.has(rel.related_id)) {
          entityToPsets.set(rel.related_id, []);
        }
        entityToPsets.get(rel.related_id)!.push(pset);
      }
      const qset = (dataModel as { quantitySets?: Map<number, ServerQuantitySet> }).quantitySets?.get(rel.relating_id);
      if (qset) {
        if (!entityToQsets.has(rel.related_id)) {
          entityToQsets.set(rel.related_id, []);
        }
        entityToQsets.get(rel.related_id)!.push(qset);
      }
    }

    // Only add relationship edges for known/mapped relationship types
    // Don't coerce unknown types to Aggregates as it corrupts semantics
    if (relType === undefined) {
      if (!unmappedRelTypes.has(upperType)) {
        unmappedRelTypes.add(upperType);
        console.debug(`[serverDataModel] Unmapped relationship type: ${rel.rel_type}`);
      }
      continue;
    }

    // Forward: relating -> related
    if (!forwardEdges.has(rel.relating_id)) {
      forwardEdges.set(rel.relating_id, []);
    }
    forwardEdges.get(rel.relating_id)!.push({ target: rel.related_id, type: relType, relationshipId: 0 });

    // Inverse: related -> relating
    if (!inverseEdges.has(rel.related_id)) {
      inverseEdges.set(rel.related_id, []);
    }
    inverseEdges.get(rel.related_id)!.push({ target: rel.relating_id, type: relType, relationshipId: 0 });
  }

  if (unmappedRelTypes.size > 0) {
    console.warn(`[serverDataModel] Found ${unmappedRelTypes.size} unmapped relationship types: ${Array.from(unmappedRelTypes).join(', ')}`);
  }

  const createEdgeAccessor = (edges: Map<number, Array<{ target: number; type: RelationshipType; relationshipId: number }>>) => ({
    offsets: new Map<number, number>(),
    counts: new Map<number, number>(),
    edgeTargets: new Uint32Array(0),
    edgeTypes: new Uint16Array(0),
    edgeRelIds: new Uint32Array(0),
    getEdges: (entityId: number, type?: RelationshipType) => {
      const e = edges.get(entityId) || [];
      return type !== undefined ? e.filter((edge) => edge.type === type) : e;
    },
    getTargets: (entityId: number, type?: RelationshipType) => {
      const e = edges.get(entityId) || [];
      const filtered = type !== undefined ? e.filter((edge) => edge.type === type) : e;
      return filtered.map((edge) => edge.target);
    },
    hasAnyEdges: (entityId: number) => (edges.get(entityId)?.length ?? 0) > 0,
  });

  const relationships: RelationshipGraph = {
    forward: createEdgeAccessor(forwardEdges),
    inverse: createEdgeAccessor(inverseEdges),
    getRelated: (entityId, relType, direction) => {
      const edgeMap = direction === 'forward' ? forwardEdges : inverseEdges;
      const edges = edgeMap.get(entityId) || [];
      return edges.filter((e) => e.type === relType).map((e) => e.target);
    },
    hasRelationship: (sourceId, targetId, relType) => {
      const edges = forwardEdges.get(sourceId) || [];
      return edges.some((e) => e.target === targetId && (relType === undefined || e.type === relType));
    },
    getRelationshipsBetween: (sourceId, targetId) => {
      const edges = forwardEdges.get(sourceId) || [];
      return edges
        .filter((e) => e.target === targetId)
        .map((e) => ({
          relationshipId: e.relationshipId,
          type: e.type,
          typeName: RelationshipType[e.type] || 'Unknown',
        }));
    },
  };

  return { relationships, entityToPsets, entityToQsets };
}

// ============================================================================
// Main Conversion Function
// ============================================================================

/**
 * Convert server data model to viewer data store format
 *
 * @param dataModel - Decoded data model from server
 * @param parseResult - Server parse result containing metadata and stats
 * @param file - Original file for size information
 * @param allMeshes - Parsed mesh data
 * @returns IfcDataStore compatible with viewer store
 */
export function convertServerDataModel(
  dataModel: DataModel,
  parseResult: ServerParseResult,
  file: { size: number },
  allMeshes: MeshData[]
): IfcDataStore {
  const strings = new StringTable();

  // Build relationships first (needed for property/quantity mappings)
  const { relationships, entityToPsets, entityToQsets } = buildRelationships(dataModel);

  // Build entity table
  const { entities, entityByIdMap, typeGroups } = buildEntityTable(dataModel, strings);

  // Convert typeGroups (IfcTypeEnum keyed, contains indices) to string-keyed Map with express IDs
  const byType = new Map<string, number[]>();
  for (const [typeEnum, indices] of typeGroups) {
    const typeName = IfcTypeEnumToString(typeEnum);
    // Map indices to actual express IDs using the entities.expressId array
    const expressIds = indices.map(idx => entities.expressId[idx]);
    byType.set(typeName, expressIds);
  }

  // Build spatial hierarchy (needs entityToPsets for storey heights)
  const spatialHierarchy = buildSpatialHierarchy(dataModel, entityToPsets);

  // Build property and quantity tables conforming to IfcDataStore's interfaces
  const properties: PropertyTable = {
    count: 0,
    entityId: new Uint32Array(0),
    psetName: new Uint32Array(0),
    psetGlobalId: new Uint32Array(0),
    propName: new Uint32Array(0),
    propType: new Uint8Array(0),
    valueString: new Uint32Array(0),
    valueReal: new Float64Array(0),
    valueInt: new Int32Array(0),
    valueBool: new Uint8Array(0),
    unitId: new Int32Array(0),
    entityIndex: new Map<number, number[]>(),
    psetIndex: new Map<number, number[]>(),
    propIndex: new Map<number, number[]>(),
    getForEntity: (exprId: number): PropertySet[] => {
      const psets = entityToPsets.get(exprId) || [];
      return psets.map((pset) => ({
        name: pset.pset_name,
        globalId: '',
        properties: pset.properties.map((p: { property_name: string; property_value: string | number | boolean | null }) => ({
          name: p.property_name,
          type: typeof p.property_value === 'number'
            ? (Number.isInteger(p.property_value) ? PropertyValueType.Integer : PropertyValueType.Real)
            : typeof p.property_value === 'boolean' ? PropertyValueType.Boolean
            : PropertyValueType.String,
          value: p.property_value as PropertyValue,
        })),
      }));
    },
    getPropertyValue: (expressId: number, psetName: string, propName: string): PropertyValue | null => {
      const psets = entityToPsets.get(expressId);
      if (!psets) {
        return null;
      }
      for (const pset of psets) {
        if (pset.pset_name === psetName) {
          for (const prop of pset.properties) {
            if (prop.property_name === propName) {
              return prop.property_value as PropertyValue;
            }
          }
        }
      }
      return null;
    },
    findByProperty: (propName: string, _operator: string, value: PropertyValue): number[] => {
      // Server-converted data: search all psets for matching property name + value
      const matchingEntityIds: number[] = [];
      for (const [entityId, psets] of entityToPsets) {
        let found = false;
        for (const pset of psets) {
          for (const prop of pset.properties) {
            if (prop.property_name === propName && prop.property_value === value) {
              matchingEntityIds.push(entityId);
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      return matchingEntityIds;
    },
  };

  /** Map server quantity type strings to QuantityType enum */
  const mapQuantityType = (type: string): QuantityType => {
    switch (type.toLowerCase()) {
      case 'length': return QuantityType.Length;
      case 'area': return QuantityType.Area;
      case 'volume': return QuantityType.Volume;
      case 'count': return QuantityType.Count;
      case 'weight': return QuantityType.Weight;
      case 'time': return QuantityType.Time;
      default: return QuantityType.Count;
    }
  };

  const quantities: QuantityTable = {
    count: 0,
    entityId: new Uint32Array(0),
    qsetName: new Uint32Array(0),
    quantityName: new Uint32Array(0),
    quantityType: new Uint8Array(0),
    value: new Float64Array(0),
    unitId: new Int32Array(0),
    formula: new Uint32Array(0),
    entityIndex: new Map<number, number[]>(),
    qsetIndex: new Map<number, number[]>(),
    quantityIndex: new Map<number, number[]>(),
    getForEntity: (exprId: number): QuantitySet[] => {
      const qsets = entityToQsets.get(exprId) || [];
      return qsets.map((qset) => ({
        name: qset.qset_name,
        quantities: qset.quantities.map((q) => ({
          name: q.quantity_name,
          type: mapQuantityType(q.quantity_type),
          value: q.quantity_value,
        })),
      }));
    },
    getQuantityValue: (expressId: number, qsetName: string, quantName: string): number | null => {
      const qsets = entityToQsets.get(expressId);
      if (!qsets) {
        return null;
      }
      for (const qset of qsets) {
        if (qset.qset_name === qsetName) {
          for (const quant of qset.quantities) {
            if (quant.quantity_name === quantName) {
              return quant.quantity_value;
            }
          }
        }
      }
      return null;
    },
    sumByType: (quantityName: string, elementType?: number): number => {
      let sum = 0;
      // Pre-compute valid IDs set for efficient type filtering
      const validIds = elementType !== undefined
        ? new Set(entities.getByType(elementType))
        : null;
      for (const [entityId, qsets] of entityToQsets) {
        // If elementType filter is specified, check entity type
        if (validIds && !validIds.has(entityId)) {
          continue;
        }
        for (const qset of qsets) {
          for (const quant of qset.quantities) {
            if (quant.quantity_name === quantityName) {
              sum += quant.quantity_value;
            }
          }
        }
      }
      return sum;
    },
  };

  // Spatial index is built asynchronously by the caller after this returns
  // to avoid blocking the main thread for seconds on large models.
  const spatialIndex: SpatialIndex | undefined = undefined;

  // Validate schemaVersion against allowed values
  const VALID_SCHEMA_VERSIONS = ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC5'] as const;
  type SchemaVersion = typeof VALID_SCHEMA_VERSIONS[number];
  const rawSchemaVersion = parseResult.metadata.schema_version;
  let schemaVersion: SchemaVersion;
  if (VALID_SCHEMA_VERSIONS.includes(rawSchemaVersion as SchemaVersion)) {
    schemaVersion = rawSchemaVersion as SchemaVersion;
  } else {
    console.warn(`[serverDataModel] Unknown schema version "${rawSchemaVersion}", defaulting to IFC4`);
    schemaVersion = 'IFC4';
  }

  return {
    fileSize: file.size,
    schemaVersion,
    entityCount: dataModel.entities.size,
    parseTime: parseResult.stats.total_time_ms,
    source: new Uint8Array(0),
    entityIndex: { byId: entityByIdMap, byType },
    strings,
    entities,
    properties,
    quantities,
    relationships,
    spatialHierarchy,
    spatialIndex,
  };
}
