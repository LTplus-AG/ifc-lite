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
  isBuildingLikeSpatialType,
  isSpaceLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
  type SpatialHierarchy,
  type SpatialNode,
  type EntityTable,
  type RelationshipGraph,
} from '@ifc-lite/data';

/**
 * Rebuild spatial hierarchy from cache data (entities + relationships)
 * OPTIMIZED: Uses index maps for O(1) lookups instead of O(n) linear searches
 *
 * @param entities - Entity table from parsed IFC
 * @param relationships - Relationship graph from parsed IFC
 * @returns Spatial hierarchy or undefined if no project found
 */
export function rebuildSpatialHierarchy(
  entities: EntityTable,
  relationships: RelationshipGraph
): SpatialHierarchy | undefined {
  // Use EntityTable.getTypeEnum() for O(1) lookups via its internal idToIndex map.
  // This avoids building a temporary Map<number, IfcTypeEnum> with 4.4M entries
  // (~350MB for large files) that duplicates data already in the entity table.

  const byStorey = new Map<number, number[]>();
  const byBuilding = new Map<number, number[]>();
  const bySite = new Map<number, number[]>();
  const bySpace = new Map<number, number[]>();
  const storeyElevations = new Map<number, number>();
  const storeyHeights = new Map<number, number>();
  const elementToStorey = new Map<number, number>();

  // Find IfcProject
  const projectIds = entities.getByType(IfcTypeEnum.IfcProject);
  if (projectIds.length === 0) {
    console.warn('[rebuildSpatialHierarchy] No IfcProject found');
    return undefined;
  }
  const projectId = projectIds[0];

  // Build node tree recursively - NOW O(1) lookups!
  function buildNode(expressId: number): SpatialNode {
    // O(1) lookup instead of O(n) linear search
    const typeEnum = entities.getTypeEnum(expressId);
    const name = entities.getName(expressId) || `Entity #${expressId}`;

    // Get contained elements via IfcRelContainedInSpatialStructure
    const rawContainedElements = relationships.getRelated(
      expressId,
      RelationshipType.ContainsElements,
      'forward'
    );

    // Split contained refs into real (non-spatial) elements vs spatial-structure
    // elements. Keep unknown types as elements (custom/newer IFC classes):
    // getTypeEnum() returns IfcTypeEnum.Unknown for both missing and unrecognized
    // entities, and isSpatialStructureType(Unknown) is false.
    //
    // A contained spatial element — an IfcSpace / IfcSpatialZone attached to a
    // storey via IfcRelContainedInSpatialStructure, which is what Revit Family +
    // Dynamo emit instead of IfcRelAggregates — is a tree NODE, not a contained
    // product. Promote it to a spatial child so it shows in the hierarchy; without
    // this it was filtered out here and vanished from the tree (#1075).
    const containedElements: number[] = [];
    const containedSpatialChildren: number[] = [];
    for (const id of rawContainedElements) {
      const elemType = entities.getTypeEnum(id);
      if (isSpatialStructureType(elemType) && elemType !== IfcTypeEnum.IfcProject) {
        containedSpatialChildren.push(id);
      } else {
        containedElements.push(id);
      }
    }

    // Get aggregated children via IfcRelAggregates
    const aggregatedChildren = relationships.getRelated(
      expressId,
      RelationshipType.Aggregates,
      'forward'
    );

    // Spatial child nodes come from BOTH aggregation and containment. Dedupe so a
    // space referenced by both relationships isn't built twice. O(1) per child.
    const childNodes: SpatialNode[] = [];
    const spatialChildIds = new Set<number>();
    const addSpatialChild = (childId: number) => {
      if (spatialChildIds.has(childId)) return;
      const childType = entities.getTypeEnum(childId);
      if (childType && isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject) {
        spatialChildIds.add(childId);
        childNodes.push(buildNode(childId));
      }
    };
    for (const childId of aggregatedChildren) addSpatialChild(childId);
    for (const childId of containedSpatialChildren) addSpatialChild(childId);

    // Add elements to appropriate maps
    if (isStoreyLikeSpatialType(typeEnum)) {
      byStorey.set(expressId, containedElements);
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      byBuilding.set(expressId, containedElements);
    } else if (typeEnum === IfcTypeEnum.IfcSite) {
      bySite.set(expressId, containedElements);
    } else if (isSpaceLikeSpatialType(typeEnum)) {
      // IfcSpace and IfcSpatialZone both roll up their contained elements here.
      bySpace.set(expressId, containedElements);
    }

    if (isStoreyLikeSpatialType(typeEnum)) {
      for (const elementId of containedElements) {
        elementToStorey.set(elementId, expressId);
        // Propagate storey assignment to aggregated descendants (e.g. IfcBuildingElementPart
        // children of an IfcWall). Without this, parts have no reverse-lookup entry even
        // though the renderer emits them as standalone meshes.
        // Cycle guard: malformed IFC files can have aggregate cycles.
        // Direct storey containment wins — only set the descendant mapping if not already set.
        const stack: number[] = [elementId];
        const seen = new Set<number>([elementId]);
        while (stack.length > 0) {
          const current = stack.pop() as number;
          const aggregatedKids = relationships.getRelated(
            current,
            RelationshipType.Aggregates,
            'forward'
          );
          for (const kid of aggregatedKids) {
            if (seen.has(kid)) continue;
            seen.add(kid);
            if (!elementToStorey.has(kid)) {
              elementToStorey.set(kid, expressId);
            }
            stack.push(kid);
          }
        }
      }
      // Map the storey's spatial children (IfcSpace / IfcSpatialZone) to it too,
      // so a selected space resolves "which storey it's on" in properties — the
      // space itself is a child node, not in containedElements (#1075).
      for (const childId of spatialChildIds) {
        if (!elementToStorey.has(childId)) {
          elementToStorey.set(childId, expressId);
        }
      }
    }

    return {
      expressId,
      type: typeEnum,
      name,
      children: childNodes,
      elements: containedElements,
    };
  }

  const projectNode = buildNode(projectId);

  // Pre-build space lookup for O(1) getContainingSpace
  const elementToSpace = new Map<number, number>();
  for (const [spaceId, elementIds] of bySpace) {
    for (const elementId of elementIds) {
      elementToSpace.set(elementId, spaceId);
    }
  }

  // Note: storeyHeights remains empty for cache path - client uses on-demand property extraction

  return {
    project: projectNode,
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

    getStoreyByElevation(): number | null {
      return null;
    },

    getContainingSpace(elementId: number): number | null {
      return elementToSpace.get(elementId) ?? null;
    },

    getPath(elementId: number): SpatialNode[] {
      const path: SpatialNode[] = [];
      const findPath = (node: SpatialNode, targetId: number): boolean => {
        path.push(node);
        if (node.elements.includes(targetId)) {
          return true;
        }
        for (const child of node.children) {
          if (findPath(child, targetId)) {
            return true;
          }
        }
        path.pop();
        return false;
      };

      findPath(projectNode, elementId);
      return path;
    },
  };
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
