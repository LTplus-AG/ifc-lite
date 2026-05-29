/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial hierarchy builder - builds project/building/storey tree
 */

import type { EntityTable, StringTable, RelationshipGraph, SpatialHierarchy, SpatialNode } from '@ifc-lite/data';
import {
  IfcTypeEnum,
  RelationshipType,
  createLogger,
  isBuildingLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
} from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';

const log = createLogger('SpatialHierarchy');

export class SpatialHierarchyBuilder {
  /**
   * Build spatial hierarchy from entities and relationships
   *
   * @param lengthUnitScale - Scale factor to convert IFC length values to meters (e.g., 0.001 for millimeters)
   */
  build(
    entities: EntityTable,
    relationships: RelationshipGraph,
    strings: StringTable,
    source: Uint8Array,
    entityIndex: { byId: { get(expressId: number): EntityRef | undefined } },
    lengthUnitScale: number = 1.0
  ): SpatialHierarchy {
    const byStorey = new Map<number, number[]>();
    const byBuilding = new Map<number, number[]>();
    const bySite = new Map<number, number[]>();
    const bySpace = new Map<number, number[]>();
    const storeyElevations = new Map<number, number>();
    const storeyHeights = new Map<number, number>();
    const elementToStorey = new Map<number, number>();

    // PRE-BUILD INDEX MAP: O(n) once, then O(1) lookups
    // This eliminates O(n²) when getTypeEnum is called for every spatial node
    const entityTypeMap = new Map<number, IfcTypeEnum>();
    for (let i = 0; i < entities.count; i++) {
      entityTypeMap.set(entities.expressId[i], entities.typeEnum[i]);
    }

    // Find IfcProject (should be only one)
    const projectIds = entities.getByType(IfcTypeEnum.IfcProject);
    if (projectIds.length === 0) {
      console.warn('[SpatialHierarchyBuilder] No IfcProject found in IFC file');
      throw new Error('No IfcProject found in IFC file');
    }
    const projectId = projectIds[0];

    // Build project node
    const projectNode = this.buildNode(
      projectId,
      entities,
      relationships,
      strings,
      source,
      entityIndex,
      byStorey,
      byBuilding,
      bySite,
      bySpace,
      storeyElevations,
      elementToStorey,
      entityTypeMap,
      lengthUnitScale
    );

    // Note: storeyHeights remains empty for client path - uses on-demand property extraction

    // Validation: log warnings if maps are empty
    if (byStorey.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No storeys found in spatial hierarchy');
    }
    if (byBuilding.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No buildings found in spatial hierarchy');
    }

    const hierarchy: SpatialHierarchy = {
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
      
      getStoreyByElevation(z: number): number | null {
        let closestStorey: number | null = null;
        let closestDistance = Infinity;
        
        for (const [storeyId, elevation] of storeyElevations) {
          const distance = Math.abs(elevation - z);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestStorey = storeyId;
          }
        }
        
        // Only return if within reasonable distance (1 meter)
        return closestDistance < 1.0 ? closestStorey : null;
      },
      
      getContainingSpace(elementId: number): number | null {
        // Check if element is directly contained in a space
        for (const [spaceId, elementIds] of bySpace) {
          if (elementIds.includes(elementId)) {
            return spaceId;
          }
        }
        return null;
      },
      
      getPath(elementId: number): SpatialNode[] {
        const path: SpatialNode[] = [];

        // Build path from project to element
        const findPath = (node: SpatialNode, targetId: number): boolean => {
          path.push(node);
          
          // Check if this node contains the target
          if (node.elements.includes(targetId)) {
            return true;
          }
          
          // Recursively search children
          for (const child of node.children) {
            if (findPath(child, targetId)) {
              return true;
            }
          }
          
          // Backtrack
          path.pop();
          return false;
        };
        
        findPath(projectNode, elementId);
        return path;
      },
    };

    return hierarchy;
  }

  private buildNode(
    expressId: number,
    entities: EntityTable,
    relationships: RelationshipGraph,
    strings: StringTable,
    source: Uint8Array,
    entityIndex: { byId: { get(expressId: number): EntityRef | undefined } },
    byStorey: Map<number, number[]>,
    byBuilding: Map<number, number[]>,
    bySite: Map<number, number[]>,
    bySpace: Map<number, number[]>,
    storeyElevations: Map<number, number>,
    elementToStorey: Map<number, number>,
    entityTypeMap: Map<number, IfcTypeEnum>,
    lengthUnitScale: number
  ): SpatialNode {
    const typeEnum = entityTypeMap.get(expressId) ?? IfcTypeEnum.Unknown;
    const name = entities.getName(expressId);

    // Extract elevation for storeys (apply unit scale to convert to meters)
    let elevation: number | undefined;
    if (typeEnum === IfcTypeEnum.IfcBuildingStorey) {
      const rawElevation = this.extractElevation(expressId, source, entityIndex);
      if (rawElevation !== undefined) {
        // Apply unit scale to convert to meters
        elevation = rawElevation * lengthUnitScale;
        storeyElevations.set(expressId, elevation);
      }
    }

    // Get direct contained elements via IfcRelContainedInSpatialStructure
    const rawContainedElements = relationships.getRelated(
      expressId,
      RelationshipType.ContainsElements,
      'forward'
    );
    // Keep entities whose type isn't in the EntityTable (e.g. IFC4x3 leaves the
    // categorizer skipped). The filter's purpose is to peel off spatial-structure
    // children — those become recursive nodes via the aggregates branch — not to
    // gate on whether the EntityTable happened to record the type. Dropping
    // missing entities silently hides every IfcReferent/IfcSignal/IfcAlignment
    // under an IfcRailway/IfcRoad even though the relationship graph has them.
    const containedElements = rawContainedElements.filter((id) => {
      const childType = entityTypeMap.get(id);
      if (childType === undefined) return true;
      return !isSpatialStructureType(childType);
    });

    // Get child spatial elements via IfcRelAggregates (inverse - who aggregates this?)
    // Actually, we want forward - what does this element aggregate?
    const aggregatedChildren = relationships.getRelated(
      expressId,
      RelationshipType.Aggregates,
      'forward'
    );

    // Filter to supported spatial container types, including IFC4.3 facility/facility-part hierarchies.
    const childNodes: SpatialNode[] = [];
    for (const childId of aggregatedChildren) {
      const childType = entityTypeMap.get(childId) ?? IfcTypeEnum.Unknown;
      if (isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject) {
        const childNode = this.buildNode(
          childId,
          entities,
          relationships,
          strings,
          source,
          entityIndex,
          byStorey,
          byBuilding,
          bySite,
          bySpace,
          storeyElevations,
          elementToStorey,
          entityTypeMap,
          lengthUnitScale
        );
        childNodes.push(childNode);
      }
    }

    // Add elements to appropriate maps
    if (isStoreyLikeSpatialType(typeEnum)) {
      byStorey.set(expressId, containedElements);
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      byBuilding.set(expressId, containedElements);
    } else if (typeEnum === IfcTypeEnum.IfcSite) {
      bySite.set(expressId, containedElements);
    } else if (typeEnum === IfcTypeEnum.IfcSpace) {
      bySpace.set(expressId, containedElements);
    }

    if (isStoreyLikeSpatialType(typeEnum)) {
      for (const elementId of containedElements) {
        elementToStorey.set(elementId, expressId);
      }
    }

    return {
      expressId,
      type: typeEnum,
      name,
      elevation,
      children: childNodes,
      elements: containedElements,
    };
  }

  /**
   * Extract elevation from IfcBuildingStorey entity
   * Elevation is at attribute index 9 in IFC4 (after GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, LongName, CompositionType)
   */
  private extractElevation(
    expressId: number,
    source: Uint8Array,
    entityIndex: { byId: { get(expressId: number): EntityRef | undefined } }
  ): number | undefined {
    const ref = entityIndex.byId.get(expressId);
    if (!ref) return undefined;

    try {
      const extractor = new EntityExtractor(source);
      const entity = extractor.extractEntity(ref);
      if (!entity) return undefined;

      const attrs = entity.attributes || [];
      
      // Helper to extract number from raw value or typed value like ['IFCLENGTHMEASURE', 3.0]
      const extractNumber = (val: any): number | undefined => {
        if (typeof val === 'number') return val;
        if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') {
          return val[1]; // Typed value: ['IFCLENGTHMEASURE', 3.0]
        }
        return undefined;
      };
      
      // Try index 9 first (correct index for IfcBuildingStorey.Elevation in IFC4)
      if (attrs.length > 9) {
        const elev = extractNumber(attrs[9]);
        if (elev !== undefined) return elev;
      }
      
      // Try index 8 (in case of schema variations)
      if (attrs.length > 8) {
        const elev = extractNumber(attrs[8]);
        if (elev !== undefined) return elev;
      }

      // Fallback: search for first numeric value that looks like an elevation
      for (let i = 0; i < attrs.length; i++) {
        const elev = extractNumber(attrs[i]);
        if (elev !== undefined && Math.abs(elev) < 10000) {
          return elev;
        }
      }
    } catch (error) {
      // Elevation extraction is optional - log for debugging but don't fail
      log.caught('Failed to extract elevation', error, {
        operation: 'extractElevation',
        entityId: expressId,
        entityType: 'IfcBuildingStorey',
      });
    }

    return undefined;
  }
}
