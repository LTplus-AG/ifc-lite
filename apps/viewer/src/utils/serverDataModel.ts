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
import { REL_TYPE_MAP as CANONICAL_REL_TYPE_MAP, EMPTY_SOURCE_BYTES, type ClassificationInfo } from '@ifc-lite/parser';
import {
  comparePropertyValues,
  IfcTypeEnumToString,
  PropertyValueType,
  QuantityType,
  RelationshipGraphBuilder,
  type RelationshipGraph,
  type PropertyTable,
  type PropertySet,
  type PropertyValue,
  type QuantityTable,
  type QuantitySet,
} from '@ifc-lite/data';
import { StringTable } from '@ifc-lite/data';
import type { SpatialIndex } from '@ifc-lite/spatial';
import { buildEntityTable } from './serverEntityTable';
import { buildSpatialHierarchy } from './serverSpatialHierarchy';

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
  // Feed the same builder the WASM path uses (#3827). Building real CSR
  // columns is what makes every `offsets`/`counts` walk downstream — the
  // Parquet Relationships table, the DuckDB relationships table — see the
  // server path's edges at all, and it is what makes the builder's
  // repeated-edge handling apply here instead of only to locally parsed
  // models. `build()` derives the inverse half from the same edge list, so
  // only the forward direction is added below.
  const graphBuilder = new RelationshipGraphBuilder();
  const entityToPsets = new Map<number, Array<any>>();
  const entityToQsets = new Map<number, Array<ServerQuantitySet>>();
  // Type-owned sets (issue #1751): the server emits synthetic TYPEHASPROPERTYSETS
  // rows (set -> type) for a type's IfcTypeObject.HasPropertySets. These are
  // "Source 1" (the type's own declaration); IfcRelDefinesByProperties targeting
  // the type is "Source 2". Collect Source 1 separately, then merge it FIRST and
  // dedup by set name — matching the WASM path's extractTypeEntityOwnProperties.
  const typeOwnPsets = new Map<number, Array<any>>();
  const typeOwnQsets = new Map<number, Array<ServerQuantitySet>>();
  const unmappedRelTypes = new Set<string>();
  // Whether the payload carried the rel_id column at all (#3860).
  let sawRelId = false;

  // Combined loop - process relationships once for both graph building AND property mapping
  for (const rel of dataModel.relationships) {
    const upperType = rel.rel_type.toUpperCase();
    const relType = CANONICAL_REL_TYPE_MAP[upperType];

    // Build property set and quantity set mappings (regardless of relType mapping)
    if (upperType === 'IFCRELDEFINESBYPROPERTIES' || upperType === 'TYPEHASPROPERTYSETS') {
      const psetTarget = upperType === 'TYPEHASPROPERTYSETS' ? typeOwnPsets : entityToPsets;
      const qsetTarget = upperType === 'TYPEHASPROPERTYSETS' ? typeOwnQsets : entityToQsets;
      const pset = dataModel.propertySets.get(rel.relating_id);
      if (pset) {
        if (!psetTarget.has(rel.related_id)) psetTarget.set(rel.related_id, []);
        psetTarget.get(rel.related_id)!.push(pset);
      }
      const qset = (dataModel as { quantitySets?: Map<number, ServerQuantitySet> }).quantitySets?.get(rel.relating_id);
      if (qset) {
        if (!qsetTarget.has(rel.related_id)) qsetTarget.set(rel.related_id, []);
        qsetTarget.get(rel.related_id)!.push(qset);
      }
      // TYPEHASPROPERTYSETS is a synthetic, non-IFC edge — never a graph edge.
      if (upperType === 'TYPEHASPROPERTYSETS') continue;
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

    // The IfcRel express id (#3860). Absent only against a server older than
    // the column; 0 is then the placeholder every edge used to get.
    if (rel.rel_id !== undefined) sawRelId = true;
    graphBuilder.addEdge(rel.relating_id, rel.related_id, relType, rel.rel_id ?? 0);
  }

  if (unmappedRelTypes.size > 0) {
    console.warn(`[serverDataModel] Found ${unmappedRelTypes.size} unmapped relationship types: ${Array.from(unmappedRelTypes).join(', ')}`);
  }

  // Every edge then carries relationshipId 0, which looks exactly like a real
  // graph until an export writes RelId = 0 on every row (#3860). Say it once.
  if (!sawRelId && dataModel.relationships.length > 0) {
    console.warn(
      `[serverDataModel] Server sent no rel_id column: all ${dataModel.relationships.length} relationship(s) get id 0. Exported RelId will be 0 — the server predates the data-model v6 payload.`
    );
  }

  // Merge each type's own (HasPropertySets) sets into its entry, FIRST and
  // name-deduped over any IfcRelDefinesByProperties-attached sets already there,
  // so `getForEntity(typeId)` matches the WASM path's type resolution and the
  // Lists adapter's server-path type fallback (issue #1751).
  const mergeOwnFirst = <T extends { pset_name?: string; qset_name?: string }>(
    own: Map<number, T[]>,
    target: Map<number, T[]>,
    nameOf: (set: T) => string,
  ) => {
    for (const [typeId, ownSets] of own) {
      const seen = new Set(ownSets.map(nameOf));
      const rest = (target.get(typeId) ?? []).filter((s) => !seen.has(nameOf(s)));
      target.set(typeId, [...ownSets, ...rest]);
    }
  };
  mergeOwnFirst(typeOwnPsets, entityToPsets, (s) => s.pset_name ?? '');
  mergeOwnFirst(typeOwnQsets, entityToQsets, (s) => s.qset_name ?? '');

  const relationships = graphBuilder.build();

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

  // Regroup server-resolved classifications by element_id (#3955).
  const resolvedClassifications = new Map<number, ClassificationInfo[]>();
  for (const c of dataModel.classifications ?? []) {
    const info: ClassificationInfo = {
      system: c.system_name,
      identification: c.identification,
      name: c.name,
      location: c.location,
    };
    const existing = resolvedClassifications.get(c.element_id);
    if (existing) {
      existing.push(info);
    } else {
      resolvedClassifications.set(c.element_id, [info]);
    }
  }
  // Build relationships first (needed for property/quantity mappings)
  const { relationships, entityToPsets, entityToQsets } = buildRelationships(dataModel);

  // Build entity table
  const { entities, entityById, typeGroups } = buildEntityTable(dataModel, strings);

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

  // Re-materialise a server property's native value + kind + measure tag from
  // the v3 wire fields (issue #1751). The server emits `property_value` as a
  // canonical STRING plus a `property_type` kind tag and optional `data_type`
  // measure tag, mirroring the WASM path's `parsePropertyValue`. Without this
  // every server property would stay a String (the raw parquet string), so
  // numeric cells wouldn't sum/sort and unit conversion (#1573) wouldn't fire.
  type ServerProp = { property_name: string; property_value: string; property_type?: string; data_type?: string; values?: string[] };
  const materializeProp = (p: ServerProp): { name: string; type: PropertyValueType; value: PropertyValue; dataType?: string; values?: string[] } => {
    const raw = p.property_value;
    let type: PropertyValueType;
    let value: PropertyValue;
    switch (p.property_type) {
      case 'boolean': type = PropertyValueType.Boolean; value = raw === 'true'; break;
      case 'logical': type = PropertyValueType.Logical; value = raw === 'true' ? true : raw === 'false' ? false : null; break;
      case 'integer': type = PropertyValueType.Integer; value = raw === '' ? null : Number(raw); break;
      case 'real':
      case 'number': type = PropertyValueType.Real; value = raw === '' ? null : Number(raw); break;
      case 'null': type = PropertyValueType.String; value = null; break;
      case 'string':
      default: type = PropertyValueType.String; value = raw; break;
    }
    return {
      name: p.property_name,
      type,
      value,
      ...(p.data_type ? { dataType: p.data_type } : {}),
      // Candidate arrays for IDS any-match checks (issue #1766) — flow through
      // the bridge's projectProperty untouched.
      ...(p.values && p.values.length > 0 ? { values: p.values } : {}),
    };
  };
  const materializeValue = (p: ServerProp): PropertyValue => materializeProp(p).value;

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
        properties: pset.properties.map((p: ServerProp) => materializeProp(p)),
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
              return materializeValue(prop);
            }
          }
        }
      }
      return null;
    },
    findByProperty: (
      propName: string,
      operator: string,
      value: PropertyValue,
      psetName?: string,
    ): number[] => {
      // Server-converted data: search psets for matching property name + value.
      // When a pset is named, restrict to it so a same-named property in
      // another pset does not match. The comparison must go through
      // `comparePropertyValues` (the same function the columnar
      // `PropertyTable.findByProperty` uses) — a bare `===` here silently
      // degraded every relational operator to equality, so `'>' 10` answered
      // `= 10`.
      const matchingEntityIds: number[] = [];
      for (const [entityId, psets] of entityToPsets) {
        let found = false;
        for (const pset of psets) {
          if (psetName !== undefined && pset.pset_name !== psetName) continue;
          for (const prop of pset.properties) {
            if (prop.property_name === propName && comparePropertyValues(materializeValue(prop), operator, value)) {
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

  const mapQuantityType = (type: string): QuantityType => { // server quantity type string -> QuantityType
    switch (type.toLowerCase()) {
      case 'length': return QuantityType.Length;
      case 'area': return QuantityType.Area;
      case 'volume': return QuantityType.Volume;
      case 'count': return QuantityType.Count;
      case 'weight': return QuantityType.Weight;
      case 'time': return QuantityType.Time;
      case 'number': return QuantityType.Number; // IfcQuantityNumber, #3266's sibling here
      default: return QuantityType.Count;
    }
  };

  const quantities: QuantityTable = {
    count: 0,
    entityId: new Uint32Array(0), qsetName: new Uint32Array(0), qsetGlobalId: new Uint32Array(0),
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
        name: qset.qset_name, globalId: '',
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
    source: EMPTY_SOURCE_BYTES,
    entityIndex: { byId: entityById, byType },
    strings,
    entities,
    properties,
    quantities,
    relationships,
    resolvedClassifications,
    spatialHierarchy,
    spatialIndex,
    // IfcStoreBase accessors: server-parsed models carry pre-built property/
    // quantity tables but no source buffer, so entity extraction is unavailable
    // (the `entities` table remains the primary path for basic attributes).
    getEntity: () => null,
    getEntitiesByType: () => [],
    getProperties: (expressId: number) => properties.getForEntity(expressId),
    getQuantities: (expressId: number) => quantities.getForEntity(expressId),
  };
}
