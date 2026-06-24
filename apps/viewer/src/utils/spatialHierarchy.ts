/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial hierarchy utilities for IFC models
 * Pure functions for building spatial structure from entities and relationships
 * Extracted from useIfc.ts for reusability and testability
 */

import {
  IfcTypeEnum,
  RelationshipType,
  type SpatialHierarchy,
  type SpatialNode,
  type EntityTable,
  type RelationshipGraph,
} from '@ifc-lite/data';
import { SpatialHierarchyBuilder } from '@ifc-lite/parser';

/**
 * Rebuild the spatial hierarchy from cache data (entities + relationships only,
 * no source buffer). Thin wrapper over the single canonical builder in
 * `@ifc-lite/parser`, so the cache path cannot drift from the fresh-parse path;
 * storey elevations stay empty without a source buffer (`getStoreyByElevation`
 * returns null).
 *
 * @param entities - Entity table from parsed IFC
 * @param relationships - Relationship graph from parsed IFC
 * @returns Spatial hierarchy or undefined if no project found
 */
export function rebuildSpatialHierarchy(
  entities: EntityTable,
  relationships: RelationshipGraph
): SpatialHierarchy | undefined {
  return new SpatialHierarchyBuilder().buildFromCache(entities, relationships);
}

/** Depth-first search for a spatial node by express id. */
function findSpatialNode(node: SpatialNode, expressId: number): SpatialNode | null {
  if (node.expressId === expressId) return node;
  for (const child of node.children) {
    const hit = findSpatialNode(child, expressId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Register a freshly-authored element into an ALREADY-BUILT spatial hierarchy,
 * in place, so it's a first-class citizen the instant it's created — visible in
 * the spatial tree under its storey and resolving its storey assignment.
 *
 * Authored entities live in the store's mutation overlay, not the columnar parse
 * the hierarchy was built from at load, so a full `rebuildSpatialHierarchy` can't
 * see them (and would be O(n) per add anyway). This patches the maps + tree
 * directly, mirroring how each relationship type lands a child:
 *   - A spatial-structure element (IfcSpace / IfcSpatialZone, linked by
 *     IfcRelAggregates) becomes a child NODE of the storey.
 *   - Any other element (slab / wall / … linked by IfcRelContainedInSpatialStructure)
 *     joins the storey's contained-element list (what the tree reads via byStorey).
 * Idempotent. A later export+reparse rebuilds the hierarchy from the real
 * relationships, so this is purely the live-session bridge.
 */
export function registerAuthoredElement(
  hierarchy: SpatialHierarchy,
  storeyExpressId: number,
  entityId: number,
  ifcTypeName: string,
  name: string,
): void {
  hierarchy.elementToStorey.set(entityId, storeyExpressId);

  const upper = ifcTypeName.toUpperCase();
  if (upper === 'IFCSPACE' || upper === 'IFCSPATIALZONE') {
    if (!hierarchy.bySpace.has(entityId)) hierarchy.bySpace.set(entityId, []);
    const storeyNode = findSpatialNode(hierarchy.project, storeyExpressId);
    if (storeyNode && !storeyNode.children.some((c) => c.expressId === entityId)) {
      storeyNode.children.push({
        expressId: entityId,
        type: upper === 'IFCSPATIALZONE' ? IfcTypeEnum.IfcSpatialZone : IfcTypeEnum.IfcSpace,
        name: name || (upper === 'IFCSPATIALZONE' ? 'IfcSpatialZone' : 'IfcSpace'),
        children: [],
        elements: [],
      });
    }
    return;
  }

  const existing = hierarchy.byStorey.get(storeyExpressId);
  if (existing) {
    if (!existing.includes(entityId)) existing.push(entityId);
  } else {
    hierarchy.byStorey.set(storeyExpressId, [entityId]);
  }
}

/**
 * Entity index type for property/quantity set lookup
 */
export interface EntityIndex {
  byId: { get(expressId: number): unknown; has(expressId: number): boolean; readonly size: number };
  byType: Map<string, number[]>;
}

/**
 * Result of rebuilding on-demand maps
 */
export interface OnDemandMaps {
  onDemandPropertyMap: Map<number, number[]>;
  onDemandQuantityMap: Map<number, number[]>;
  /** element/type expressId -> associated material definition expressId. */
  onDemandMaterialMap: Map<number, number>;
}

/** IFC material *definition* classes that can be the RelatingMaterial of an
 *  IfcRelAssociatesMaterial — the source nodes of AssociatesMaterial edges. */
const MATERIAL_DEF_TYPES = new Set([
  'IFCMATERIAL',
  'IFCMATERIALLAYERSET',
  'IFCMATERIALLAYERSETUSAGE',
  'IFCMATERIALPROFILESET',
  'IFCMATERIALPROFILESETUSAGE',
  'IFCMATERIALCONSTITUENTSET',
  'IFCMATERIALLIST',
]);

/**
 * Rebuild on-demand property/quantity maps from relationships and entity types
 * Uses FORWARD direction: pset -> elements (more efficient than inverse lookup)
 * OPTIMIZED: Uses entityIndex.byType for property/quantity set lookup since
 * the entity table may not include these types (filtered during fresh parse)
 *
 * @param entities - Entity table from parsed IFC
 * @param relationships - Relationship graph from parsed IFC
 * @param entityIndex - Optional entity index with byType map for cache loads
 * @returns Maps from entity ID to property/quantity set IDs
 */
export function rebuildOnDemandMaps(
  entities: EntityTable,
  relationships: RelationshipGraph,
  entityIndex?: EntityIndex
): OnDemandMaps {
  const onDemandPropertyMap = new Map<number, number[]>();
  const onDemandQuantityMap = new Map<number, number[]>();
  const onDemandMaterialMap = new Map<number, number>();

  // Use entityIndex.byType if available (needed for cache loads where entity table
  // doesn't include IfcPropertySet/IfcElementQuantity entities)
  // Fall back to entities.getByType() for fresh parses where entity table has these types
  let propertySets: number[];
  let quantitySets: number[];

  if (entityIndex?.byType) {
    // entityIndex.byType keys are the original type strings from the IFC file
    // Check both common casings (STEP files may use either)
    propertySets =
      entityIndex.byType.get('IFCPROPERTYSET') || entityIndex.byType.get('IfcPropertySet') || [];
    quantitySets =
      entityIndex.byType.get('IFCELEMENTQUANTITY') ||
      entityIndex.byType.get('IfcElementQuantity') ||
      [];
  } else {
    // Fallback for when entityIndex is not provided
    propertySets = entities.getByType(IfcTypeEnum.IfcPropertySet);
    quantitySets = entities.getByType(IfcTypeEnum.IfcElementQuantity);
  }

  // Process property sets
  for (const psetId of propertySets) {
    // Get elements defined by this pset (FORWARD: pset -> elements)
    const definedElements = relationships.getRelated(
      psetId,
      RelationshipType.DefinesByProperties,
      'forward'
    );

    for (const entityId of definedElements) {
      let list = onDemandPropertyMap.get(entityId);
      if (!list) {
        list = [];
        onDemandPropertyMap.set(entityId, list);
      }
      list.push(psetId);
    }
  }

  // Process quantity sets
  for (const qsetId of quantitySets) {
    // Get elements defined by this qset (FORWARD: qset -> elements)
    const definedElements = relationships.getRelated(
      qsetId,
      RelationshipType.DefinesByProperties,
      'forward'
    );

    for (const entityId of definedElements) {
      let list = onDemandQuantityMap.get(entityId);
      if (!list) {
        list = [];
        onDemandQuantityMap.set(entityId, list);
      }
      list.push(qsetId);
    }
  }

  // Process material associations (FORWARD: material definition -> elements),
  // mirroring the columnar parser's onDemandMaterialMap. Needed so cache-loaded
  // models populate the Materials tab + per-material totals, which read this map
  // (the relationship-graph fallback only covers single-element lookups, not the
  // model-wide usage index). Requires entityIndex.byType to enumerate material
  // definitions — the cached graph preserves AssociatesMaterial edges.
  let materialDefCount = 0;
  if (entityIndex?.byType) {
    for (const [typeKey, ids] of entityIndex.byType) {
      if (!MATERIAL_DEF_TYPES.has(typeKey.toUpperCase())) continue;
      for (const materialId of ids) {
        materialDefCount += 1;
        const associated = relationships.getRelated(
          materialId,
          RelationshipType.AssociatesMaterial,
          'forward'
        );
        for (const entityId of associated) {
          // Last association wins, matching the columnar parser's `.set` build.
          onDemandMaterialMap.set(entityId, materialId);
        }
      }
    }
  }

  console.log(
    `[spatialHierarchy] Rebuilt on-demand maps: ${propertySets.length} psets, ${quantitySets.length} qsets, ${materialDefCount} material defs -> ${onDemandPropertyMap.size} entities with properties, ${onDemandQuantityMap.size} with quantities, ${onDemandMaterialMap.size} with materials`
  );
  return { onDemandPropertyMap, onDemandQuantityMap, onDemandMaterialMap };
}
