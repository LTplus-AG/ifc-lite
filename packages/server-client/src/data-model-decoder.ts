/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decode Parquet-encoded data model from server.
 */

import { ensureParquetInit } from './parquet-decoder.js';

export interface EntityMetadata {
  entity_id: number;
  type_name: string;
  global_id?: string;
  name?: string;
  description?: string;
  object_type?: string;
  has_geometry: boolean;
}

export interface Property {
  property_name: string;
  property_value: string;
  property_type: string;
}

export interface PropertySet {
  pset_id: number;
  pset_name: string;
  properties: Property[];
}

export interface Quantity {
  quantity_name: string;
  quantity_value: number;
  quantity_type: string;
}

export interface QuantitySet {
  qset_id: number;
  qset_name: string;
  method_of_measurement?: string;
  quantities: Quantity[];
}

export interface Relationship {
  rel_type: string;
  relating_id: number;
  related_id: number;
}

export interface SpatialNode {
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

export interface SpatialHierarchy {
  nodes: SpatialNode[];
  project_id: number;
  element_to_storey: Map<number, number>;
  element_to_building: Map<number, number>;
  element_to_site: Map<number, number>;
  element_to_space: Map<number, number>;
}

/** A classification reference associated with one element. */
export interface ClassificationAssociation {
  element_id: number;
  /** Classification system name (`IfcClassification.Name`). */
  system_name?: string;
  /** Code / `IfcClassificationReference.Identification`. */
  identification?: string;
  /** Human-readable reference name. */
  name?: string;
  /** Location / URI. */
  location?: string;
}

/** A material (or one material layer) associated with an element. */
export interface MaterialAssociation {
  element_id: number;
  /** Layer-set name; absent for a single material / list / constituent set. */
  set_name?: string;
  /** 0-based layer index within its set (0 for a single material). */
  layer_index: number;
  material_name: string;
  /** Layer thickness in metres (already unit-scaled); absent if not a layer. */
  thickness?: number;
  is_ventilated?: boolean;
  category?: string;
}

/** A document associated with an element. */
export interface DocumentAssociation {
  element_id: number;
  identification?: string;
  name?: string;
  location?: string;
  description?: string;
}

export interface DataModel {
  entities: Map<number, EntityMetadata>;
  propertySets: Map<number, PropertySet>;
  quantitySets: Map<number, QuantitySet>;
  relationships: Relationship[];
  /**
   * Classification references per element (`IfcRelAssociatesClassification`).
   * Empty when served by an older server / cache that predates this field.
   */
  classifications: ClassificationAssociation[];
  /** Materials / material layers per element (`IfcRelAssociatesMaterial`). */
  materials: MaterialAssociation[];
  /** Documents per element (`IfcRelAssociatesDocument`). */
  documents: DocumentAssociation[];
  spatialHierarchy: SpatialHierarchy;
}

/**
 * Decode data model from Parquet buffer.
 *
 * OPTIMIZED: Uses toArray() for bulk string extraction instead of per-element .get() calls.
 * Arrow's .get(i) is slow for strings (offset lookup + UTF-8 decode per call).
 * toArray() decodes all strings in one pass which is 10-20x faster for large datasets.
 *
 * Format: [entities_len][entities_data][properties_len][properties_data][quantities_len][quantities_data][relationships_len][relationships_data][spatial_len][spatial_data]
 */
export async function decodeDataModel(data: ArrayBuffer): Promise<DataModel> {
  // Initialize WASM module (only runs once)
  const parquet = await ensureParquetInit();
  // apache-arrow's browser export map hides the `.d.ts` from TS5's
  // strict resolver — fall back to `any` for the dynamic import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrow: any = await import('apache-arrow');

  const view = new DataView(data);
  let offset = 0;

  // Read entities Parquet section
  const entitiesLen = view.getUint32(offset, true);
  offset += 4;
  const entitiesData = new Uint8Array(data, offset, entitiesLen);
  offset += entitiesLen;

  // Read properties Parquet section
  const propertiesLen = view.getUint32(offset, true);
  offset += 4;
  const propertiesData = new Uint8Array(data, offset, propertiesLen);
  offset += propertiesLen;

  // Read quantities Parquet section
  const quantitiesLen = view.getUint32(offset, true);
  offset += 4;
  const quantitiesData = new Uint8Array(data, offset, quantitiesLen);
  offset += quantitiesLen;

  // Read relationships Parquet section
  const relationshipsLen = view.getUint32(offset, true);
  offset += 4;
  const relationshipsData = new Uint8Array(data, offset, relationshipsLen);
  offset += relationshipsLen;

  // Read spatial Parquet section
  const spatialLen = view.getUint32(offset, true);
  offset += 4;
  const spatialData = new Uint8Array(data, offset, spatialLen);
  offset += spatialLen;

  // Read an optional appended length-prefixed section. Returns null only when
  // no length prefix remains — i.e. an older server/cache that omits the
  // classification/material/document tables (see the writer in
  // parquet_data_model.rs). Once a prefix is present, a zero length or a length
  // that overruns the buffer means the payload is malformed, so we throw rather
  // than silently dropping data as if it were an old payload.
  const readOptionalSection = (): Uint8Array | null => {
    if (offset + 4 > data.byteLength) return null; // section absent (old payload)
    const len = view.getUint32(offset, true);
    offset += 4;
    if (len === 0 || offset + len > data.byteLength) {
      throw new Error(
        `Malformed data model: truncated appended section (len=${len}, remaining=${data.byteLength - offset})`
      );
    }
    const section = new Uint8Array(data, offset, len);
    offset += len;
    return section;
  };
  const classificationsData = readOptionalSection();
  const materialsData = readOptionalSection();
  const documentsData = readOptionalSection();

  // Parse Parquet tables
  const entitiesTable = parquet.readParquet(entitiesData);
  const propertiesTable = parquet.readParquet(propertiesData);
  const relationshipsTable = parquet.readParquet(relationshipsData);

  // Convert to Arrow tables
  const entitiesArrow = arrow.tableFromIPC(entitiesTable.intoIPCStream());
  const propertiesArrow = arrow.tableFromIPC(propertiesTable.intoIPCStream());
  const relationshipsArrow = arrow.tableFromIPC(relationshipsTable.intoIPCStream());

  // OPTIMIZED: Extract ALL columns as arrays upfront
  // This is MUCH faster than calling .get(i) millions of times
  // toArray() decodes all strings in one pass vs per-element offset lookup + UTF-8 decode
  const entityIds = entitiesArrow.getChild('entity_id')?.toArray() as Uint32Array;
  const hasGeometry = entitiesArrow.getChild('has_geometry')?.toArray() as Uint8Array;
  const typeNames = entitiesArrow.getChild('type_name')?.toArray() as string[];
  const globalIds = entitiesArrow.getChild('global_id')?.toArray() as (string | null)[];
  const names = entitiesArrow.getChild('name')?.toArray() as (string | null)[];
  // Description and object_type may not be present in older server versions
  const descriptions = entitiesArrow.getChild('description')?.toArray() as (string | null)[] | undefined;
  const objectTypes = entitiesArrow.getChild('object_type')?.toArray() as (string | null)[] | undefined;
  const entityCount = entityIds.length;

  // Build entity map with pre-extracted arrays (no per-element .get() calls)
  const entities = new Map<number, EntityMetadata>();
  for (let i = 0; i < entityCount; i++) {
    entities.set(entityIds[i], {
      entity_id: entityIds[i],
      type_name: typeNames[i] ?? '',
      global_id: globalIds[i] || undefined,
      name: names[i] || undefined,
      description: descriptions?.[i] || undefined,
      object_type: objectTypes?.[i] || undefined,
      has_geometry: hasGeometry[i] !== 0,
    });
  }

  // OPTIMIZED: Extract all property columns as arrays upfront
  const psetIds = propertiesArrow.getChild('pset_id')?.toArray() as Uint32Array;
  const psetNamesArr = propertiesArrow.getChild('pset_name')?.toArray() as string[];
  const propertyNamesArr = propertiesArrow.getChild('property_name')?.toArray() as string[];
  const propertyValuesArr = propertiesArrow.getChild('property_value')?.toArray() as string[];
  const propertyTypesArr = propertiesArrow.getChild('property_type')?.toArray() as string[];

  const propertySets = new Map<number, PropertySet>();
  for (let i = 0; i < psetIds.length; i++) {
    const psetId = psetIds[i];
    if (!propertySets.has(psetId)) {
      propertySets.set(psetId, {
        pset_id: psetId,
        pset_name: psetNamesArr[i] ?? '',
        properties: [],
      });
    }
    const pset = propertySets.get(psetId)!;
    pset.properties.push({
      property_name: propertyNamesArr[i] ?? '',
      property_value: propertyValuesArr[i] ?? '',
      property_type: propertyTypesArr[i] ?? '',
    });
  }

  // OPTIMIZED: Parse quantities Parquet table
  const quantitiesTable = parquet.readParquet(quantitiesData);
  const quantitiesArrow = arrow.tableFromIPC(quantitiesTable.intoIPCStream());

  // Extract all quantity columns as arrays upfront
  const qsetIds = quantitiesArrow.getChild('qset_id')?.toArray() as Uint32Array;
  const qsetNamesArr = quantitiesArrow.getChild('qset_name')?.toArray() as string[];
  const methodsArr = quantitiesArrow.getChild('method_of_measurement')?.toArray() as (string | null)[];
  const quantityNamesArr = quantitiesArrow.getChild('quantity_name')?.toArray() as string[];
  const quantityValuesArr = quantitiesArrow.getChild('quantity_value')?.toArray() as Float64Array;
  const quantityTypesArr = quantitiesArrow.getChild('quantity_type')?.toArray() as string[];

  const quantitySets = new Map<number, QuantitySet>();
  for (let i = 0; i < qsetIds.length; i++) {
    const qsetId = qsetIds[i];
    if (!quantitySets.has(qsetId)) {
      quantitySets.set(qsetId, {
        qset_id: qsetId,
        qset_name: qsetNamesArr[i] ?? '',
        method_of_measurement: methodsArr[i] || undefined,
        quantities: [],
      });
    }
    const qset = quantitySets.get(qsetId)!;
    qset.quantities.push({
      quantity_name: quantityNamesArr[i] ?? '',
      quantity_value: quantityValuesArr[i] ?? 0,
      quantity_type: quantityTypesArr[i] ?? '',
    });
  }

  // OPTIMIZED: Extract relationship columns as arrays
  const relTypesArr = relationshipsArrow.getChild('rel_type')?.toArray() as string[];
  const relatingIds = relationshipsArrow.getChild('relating_id')?.toArray() as Uint32Array;
  const relatedIds = relationshipsArrow.getChild('related_id')?.toArray() as Uint32Array;

  // Pre-allocate array for better performance
  const relationships: Relationship[] = new Array(relatingIds.length);
  for (let i = 0; i < relatingIds.length; i++) {
    relationships[i] = {
      rel_type: relTypesArr[i] ?? '',
      relating_id: relatingIds[i],
      related_id: relatedIds[i],
    };
  }

  // Parse spatial hierarchy - format: [nodes_len][nodes_data][element_to_storey_len][element_to_storey_data]...
  const spatialView = new DataView(spatialData.buffer, spatialData.byteOffset, spatialData.byteLength);
  let spatialOffset = 0;

  // Read nodes table
  const nodesLen = spatialView.getUint32(spatialOffset, true);
  spatialOffset += 4;
  const nodesData = new Uint8Array(spatialData.buffer, spatialData.byteOffset + spatialOffset, nodesLen);
  spatialOffset += nodesLen;

  // Read lookup tables
  const elementToStoreyLen = spatialView.getUint32(spatialOffset, true);
  spatialOffset += 4;
  const elementToStoreyData = new Uint8Array(spatialData.buffer, spatialData.byteOffset + spatialOffset, elementToStoreyLen);
  spatialOffset += elementToStoreyLen;

  const elementToBuildingLen = spatialView.getUint32(spatialOffset, true);
  spatialOffset += 4;
  const elementToBuildingData = new Uint8Array(spatialData.buffer, spatialData.byteOffset + spatialOffset, elementToBuildingLen);
  spatialOffset += elementToBuildingLen;

  const elementToSiteLen = spatialView.getUint32(spatialOffset, true);
  spatialOffset += 4;
  const elementToSiteData = new Uint8Array(spatialData.buffer, spatialData.byteOffset + spatialOffset, elementToSiteLen);
  spatialOffset += elementToSiteLen;

  const elementToSpaceLen = spatialView.getUint32(spatialOffset, true);
  spatialOffset += 4;
  const elementToSpaceData = new Uint8Array(spatialData.buffer, spatialData.byteOffset + spatialOffset, elementToSpaceLen);
  spatialOffset += elementToSpaceLen;

  // Read project_id (final u32)
  const projectId = spatialView.getUint32(spatialOffset, true);

  // OPTIMIZED: Parse nodes Parquet table with bulk array extraction
  const nodesTable = parquet.readParquet(nodesData);
  const nodesArrow = arrow.tableFromIPC(nodesTable.intoIPCStream());

  // Extract ALL columns as arrays upfront (same optimization as entities)
  const spatialEntityIds = nodesArrow.getChild('entity_id')?.toArray() as Uint32Array;
  const parentIdsArr = nodesArrow.getChild('parent_id')?.toArray() as Uint32Array;
  const levels = nodesArrow.getChild('level')?.toArray() as Uint16Array;
  const pathsArr = nodesArrow.getChild('path')?.toArray() as string[];
  const spatialTypeNamesArr = nodesArrow.getChild('type_name')?.toArray() as string[];
  const spatialNamesArr = nodesArrow.getChild('name')?.toArray() as (string | null)[];
  const elevationsArr = nodesArrow.getChild('elevation')?.toArray() as (number | null)[];
  const childrenIdsList = nodesArrow.getChild('children_ids');
  const elementIdsList = nodesArrow.getChild('element_ids');

  // Pre-allocate array for spatial nodes
  const nodeCount = spatialEntityIds.length;
  const spatialNodes: SpatialNode[] = new Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    // For list arrays, we still need .get(i) but use spread for faster copy
    let childrenIds: number[] = [];
    let elementIds: number[] = [];

    if (childrenIdsList) {
      const childrenVector = childrenIdsList.get(i) as { toArray(): Uint32Array } | null;
      if (childrenVector) {
        // Use spread operator - slightly faster than Array.from for small arrays
        childrenIds = [...childrenVector.toArray()];
      }
    }

    if (elementIdsList) {
      const elementVector = elementIdsList.get(i) as { toArray(): Uint32Array } | null;
      if (elementVector) {
        elementIds = [...elementVector.toArray()];
      }
    }

    spatialNodes[i] = {
      entity_id: spatialEntityIds[i],
      parent_id: parentIdsArr[i] ?? 0,
      level: levels[i],
      path: pathsArr[i] ?? '',
      type_name: spatialTypeNamesArr[i] ?? '',
      name: spatialNamesArr[i] || undefined,
      elevation: elevationsArr[i] ?? undefined,
      children_ids: childrenIds,
      element_ids: elementIds,
    };
  }

  // OPTIMIZED: Parse lookup tables in parallel using Promise.all
  // Each table is independent, so we can parse them concurrently
  const parseLookupTable = (tableData: Uint8Array): Map<number, number> => {
    const table = parquet.readParquet(tableData);
    const arrowTable = arrow.tableFromIPC(table.intoIPCStream());
    const elemIds = arrowTable.getChild('element_id')?.toArray() as Uint32Array;
    const spatIds = arrowTable.getChild('spatial_id')?.toArray() as Uint32Array;
    const map = new Map<number, number>();
    for (let i = 0; i < elemIds.length; i++) {
      map.set(elemIds[i], spatIds[i]);
    }
    return map;
  };

  // Parse all 4 lookup tables (these are typically small, but parallelizing still helps)
  const [elementToStorey, elementToBuilding, elementToSite, elementToSpace] = [
    parseLookupTable(elementToStoreyData),
    parseLookupTable(elementToBuildingData),
    parseLookupTable(elementToSiteData),
    parseLookupTable(elementToSpaceData),
  ];

  // Classification associations (issue #900). Absent on older caches.
  const classifications: ClassificationAssociation[] = [];
  if (classificationsData) {
    const t = arrow.tableFromIPC(parquet.readParquet(classificationsData).intoIPCStream());
    const elementIds = t.getChild('element_id')?.toArray() as Uint32Array;
    const systemNames = t.getChild('system_name')?.toArray() as (string | null)[];
    const identifications = t.getChild('identification')?.toArray() as (string | null)[];
    const namesArr = t.getChild('name')?.toArray() as (string | null)[];
    const locations = t.getChild('location')?.toArray() as (string | null)[];
    for (let i = 0; i < elementIds.length; i++) {
      classifications.push({
        element_id: elementIds[i],
        system_name: systemNames?.[i] || undefined,
        identification: identifications?.[i] || undefined,
        name: namesArr?.[i] || undefined,
        location: locations?.[i] || undefined,
      });
    }
  }

  // Material associations (issue #900).
  const materials: MaterialAssociation[] = [];
  if (materialsData) {
    const t = arrow.tableFromIPC(parquet.readParquet(materialsData).intoIPCStream());
    const elementIds = t.getChild('element_id')?.toArray() as Uint32Array;
    const setNames = t.getChild('set_name')?.toArray() as (string | null)[];
    const layerIndices = t.getChild('layer_index')?.toArray() as Uint32Array;
    const materialNames = t.getChild('material_name')?.toArray() as (string | null)[];
    const thicknesses = t.getChild('thickness')?.toArray() as (number | null)[];
    const ventChild = t.getChild('is_ventilated');
    const categories = t.getChild('category')?.toArray() as (string | null)[];
    for (let i = 0; i < elementIds.length; i++) {
      const vent = ventChild?.get(i);
      materials.push({
        element_id: elementIds[i],
        set_name: setNames?.[i] || undefined,
        layer_index: layerIndices[i],
        material_name: materialNames?.[i] ?? '',
        thickness: thicknesses?.[i] ?? undefined,
        is_ventilated: vent === null || vent === undefined ? undefined : Boolean(vent),
        category: categories?.[i] || undefined,
      });
    }
  }

  // Document associations (issue #900).
  const documents: DocumentAssociation[] = [];
  if (documentsData) {
    const t = arrow.tableFromIPC(parquet.readParquet(documentsData).intoIPCStream());
    const elementIds = t.getChild('element_id')?.toArray() as Uint32Array;
    const identifications = t.getChild('identification')?.toArray() as (string | null)[];
    const namesArr = t.getChild('name')?.toArray() as (string | null)[];
    const locations = t.getChild('location')?.toArray() as (string | null)[];
    const descriptions = t.getChild('description')?.toArray() as (string | null)[];
    for (let i = 0; i < elementIds.length; i++) {
      documents.push({
        element_id: elementIds[i],
        identification: identifications?.[i] || undefined,
        name: namesArr?.[i] || undefined,
        location: locations?.[i] || undefined,
        description: descriptions?.[i] || undefined,
      });
    }
  }

  return {
    entities,
    propertySets,
    quantitySets,
    relationships,
    classifications,
    materials,
    documents,
    spatialHierarchy: {
      nodes: spatialNodes,
      project_id: projectId,
      element_to_storey: elementToStorey,
      element_to_building: elementToBuilding,
      element_to_site: elementToSite,
      element_to_space: elementToSpace,
    },
  };
}
