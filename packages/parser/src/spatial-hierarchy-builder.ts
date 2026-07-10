/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial hierarchy builder - builds the project/site/building/storey tree.
 *
 * Single source for spatial-hierarchy construction. There are two entry points
 * over one shared `buildNode`:
 *   - `build(...)`     fresh parse: extracts storey elevations from the source
 *                      buffer. Throws if there is no IfcProject.
 *   - `buildFromCache` cache restore: no source buffer, so storey elevations
 *                      stay empty. Returns undefined if there is no IfcProject.
 * Both paths get the same cycle guard, aggregate-descendant storey mapping, and
 * spatial-child promotion, so they cannot drift.
 */

import type { EntityTable, StringTable, RelationshipGraph, SpatialHierarchy, SpatialNode } from '@ifc-lite/data';
import {
  IfcTypeEnum,
  RelationshipType,
  createLogger,
  isBuildingLikeSpatialType,
  isSpaceLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
} from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import { getAttributeNamesAcrossSchemas } from './ifc-schema.js';

const log = createLogger('SpatialHierarchy');

/** Source bytes needed to read on-demand attributes off the raw records
 *  (storey elevation, LongName). Present on the fresh-parse / cache-with-source
 *  path, absent on the source-less `buildFromCache` fallback. */
interface AttributeSource {
  source: Uint8Array;
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined } };
  lengthUnitScale: number;
}

/** Accumulators threaded through the recursion, plus the optional attribute source. */
interface BuildContext {
  entities: EntityTable;
  relationships: RelationshipGraph;
  byStorey: Map<number, number[]>;
  byBuilding: Map<number, number[]>;
  bySite: Map<number, number[]>;
  bySpace: Map<number, number[]>;
  storeyElevations: Map<number, number>;
  elementToStorey: Map<number, number>;
  /** elementId -> nearest containing spatial node at ANY level (see the
   *  SpatialHierarchy field docs). Covers aggregated descendants of a
   *  directly-contained element, unlike the storey-only `elementToStorey`. */
  elementToContainer: Map<number, number>;
  visited: Set<number>;
  attrSource?: AttributeSource;
  /** One extractor reused across the recursion when a source is available, so
   *  LongName reads don't re-allocate per spatial node. */
  attrExtractor?: EntityExtractor;
}

export class SpatialHierarchyBuilder {
  /**
   * Fresh-parse build. Extracts storey elevations from the source buffer.
   * Throws if no IfcProject is present.
   *
   * @param lengthUnitScale - Scale to convert IFC length values to meters (e.g. 0.001 for millimeters).
   */
  build(
    entities: EntityTable,
    relationships: RelationshipGraph,
    _strings: StringTable,
    source: Uint8Array,
    entityIndex: { byId: { get(expressId: number): EntityRef | undefined } },
    lengthUnitScale: number = 1.0
  ): SpatialHierarchy {
    const hierarchy = this.assemble(entities, relationships, { source, entityIndex, lengthUnitScale }, true);
    // assemble only returns undefined when throwOnNoProject is false.
    return hierarchy as SpatialHierarchy;
  }

  /**
   * Cache-restore build. No source buffer, so storey elevations stay empty
   * (`getStoreyByElevation` returns null). Returns undefined if no IfcProject.
   */
  buildFromCache(
    entities: EntityTable,
    relationships: RelationshipGraph
  ): SpatialHierarchy | undefined {
    return this.assemble(entities, relationships, undefined, false);
  }

  private assemble(
    entities: EntityTable,
    relationships: RelationshipGraph,
    attrSource: AttributeSource | undefined,
    throwOnNoProject: boolean
  ): SpatialHierarchy | undefined {
    const ctx: BuildContext = {
      entities,
      relationships,
      byStorey: new Map(),
      byBuilding: new Map(),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      elementToStorey: new Map(),
      elementToContainer: new Map(),
      visited: new Set(),
      attrSource,
      attrExtractor: attrSource ? new EntityExtractor(attrSource.source) : undefined,
    };

    const projectIds = entities.getByType(IfcTypeEnum.IfcProject);
    if (projectIds.length === 0) {
      console.warn('[SpatialHierarchyBuilder] No IfcProject found in IFC file');
      if (throwOnNoProject) {
        throw new Error('No IfcProject found in IFC file');
      }
      return undefined;
    }

    const projectNode = this.buildNode(projectIds[0], ctx);

    if (ctx.byStorey.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No storeys found in spatial hierarchy');
    }
    if (ctx.byBuilding.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No buildings found in spatial hierarchy');
    }

    const { byStorey, byBuilding, bySite, bySpace, storeyElevations, elementToStorey, elementToContainer } = ctx;

    // Pre-build the element -> space lookup for O(1) getContainingSpace.
    const elementToSpace = new Map<number, number>();
    for (const [spaceId, elementIds] of bySpace) {
      for (const elementId of elementIds) {
        elementToSpace.set(elementId, spaceId);
      }
    }

    return {
      project: projectNode,
      byStorey,
      byBuilding,
      bySite,
      bySpace,
      storeyElevations,
      // storeyHeights stays empty: both paths use on-demand property extraction.
      storeyHeights: new Map<number, number>(),
      elementToStorey,
      elementToContainer,

      getStoreyElements(storeyId: number): number[] {
        return byStorey.get(storeyId) ?? [];
      },

      getStoreyByElevation(z: number): number | null {
        // With an empty storeyElevations map (cache path) this returns null.
        let closestStorey: number | null = null;
        let closestDistance = Infinity;
        for (const [storeyId, elevation] of storeyElevations) {
          const distance = Math.abs(elevation - z);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestStorey = storeyId;
          }
        }
        // Only return if within a reasonable distance (1 meter).
        return closestDistance < 1.0 ? closestStorey : null;
      },

      getContainingSpace(elementId: number): number | null {
        return elementToSpace.get(elementId) ?? null;
      },

      getPath(elementId: number): SpatialNode[] {
        const path: SpatialNode[] = [];
        const findPath = (node: SpatialNode, targetId: number): boolean => {
          path.push(node);
          // Match the node itself (so a promoted space/zone resolves) or one of
          // its contained elements.
          if (node.expressId === targetId || node.elements.includes(targetId)) {
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

  private buildNode(expressId: number, ctx: BuildContext): SpatialNode {
    const { entities, relationships } = ctx;
    const typeEnum = entities.getTypeEnum(expressId);
    const rawName = entities.getName(expressId);
    // LongName is the descriptive label authors put alongside an ISO 19650 code
    // in Name (Name "01" / LongName "Main Residence"), so the hierarchy panel can
    // show both (issue #1634). It lives only in the raw record, so it needs the
    // source bytes; the source-less buildFromCache fallback leaves it undefined,
    // exactly like storey elevation.
    const rawLongName = this.extractLongName(expressId, ctx);
    // Fall back to LongName when Name is empty (common for IfcSpace), then to a
    // stable placeholder, so every node still renders a label.
    const name = rawName || rawLongName || `Entity #${expressId}`;
    // Only keep LongName as a distinct descriptor when it adds something beyond
    // the primary label (never duplicate it into the secondary slot).
    const longName = rawLongName && rawLongName !== name ? rawLongName : undefined;

    // Guard against cyclic IfcRelAggregates chains (A aggregates B, B aggregates
    // A), which would otherwise recurse unbounded and overflow the stack. A
    // revisited node is returned as a leaf so the rest of the hierarchy still
    // builds.
    if (ctx.visited.has(expressId)) {
      return { expressId, type: typeEnum, name, longName, elevation: undefined, children: [], elements: [] };
    }
    ctx.visited.add(expressId);

    // Storey elevation (fresh path only): apply unit scale to convert to meters.
    let elevation: number | undefined;
    if (typeEnum === IfcTypeEnum.IfcBuildingStorey && ctx.attrSource) {
      const { source, entityIndex, lengthUnitScale } = ctx.attrSource;
      let rawElevation = this.extractElevation(expressId, source, entityIndex);
      if (rawElevation === undefined) {
        // Elevation is optional and frequently null (Revit / ArchiCAD). Fall back
        // to the storey's Z from its ObjectPlacement so it still orders + lifts in
        // Exploded mode instead of collapsing to a single floor (#1289).
        rawElevation = this.extractPlacementElevation(expressId, source, entityIndex);
      }
      if (rawElevation !== undefined) {
        elevation = rawElevation * lengthUnitScale;
        ctx.storeyElevations.set(expressId, elevation);
      }
    }

    // Direct contained elements via IfcRelContainedInSpatialStructure.
    const rawContainedElements = relationships.getRelated(expressId, RelationshipType.ContainsElements, 'forward');

    // Split contained refs into real (non-spatial) elements vs spatial-structure
    // children. Unknown types stay elements (getTypeEnum returns Unknown for both
    // missing and unrecognized entities, and isSpatialStructureType(Unknown) is
    // false). A contained IfcSpace / IfcSpatialZone (what Revit Family + Dynamo
    // emit instead of IfcRelAggregates) is a tree NODE, not a product: promote it
    // below so it shows in the hierarchy instead of vanishing (#1075).
    const containedElements: number[] = [];
    const containedSpatialChildren: number[] = [];
    for (const id of rawContainedElements) {
      const childType = entities.getTypeEnum(id);
      if (isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject) {
        containedSpatialChildren.push(id);
      } else {
        containedElements.push(id);
      }
    }

    // Forward IfcRelAggregates: what does this element aggregate?
    const aggregatedChildren = relationships.getRelated(expressId, RelationshipType.Aggregates, 'forward');

    // Spatial child nodes come from BOTH aggregation and containment. Dedupe so a
    // space referenced by both relationships isn't built twice.
    const childNodes: SpatialNode[] = [];
    const spatialChildIds = new Set<number>();
    const addSpatialChild = (childId: number) => {
      if (spatialChildIds.has(childId)) return;
      const childType = entities.getTypeEnum(childId);
      if (isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject) {
        spatialChildIds.add(childId);
        childNodes.push(this.buildNode(childId, ctx));
      }
    };
    for (const childId of aggregatedChildren) addSpatialChild(childId);
    for (const childId of containedSpatialChildren) addSpatialChild(childId);

    // Roll contained elements up to the appropriate map.
    if (isStoreyLikeSpatialType(typeEnum)) {
      ctx.byStorey.set(expressId, containedElements);
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      ctx.byBuilding.set(expressId, containedElements);
    } else if (typeEnum === IfcTypeEnum.IfcSite) {
      ctx.bySite.set(expressId, containedElements);
    } else if (isSpaceLikeSpatialType(typeEnum)) {
      // IfcSpace and IfcSpatialZone both roll up their contained elements here.
      ctx.bySpace.set(expressId, containedElements);
    }

    if (isStoreyLikeSpatialType(typeEnum)) {
      for (const elementId of containedElements) {
        ctx.elementToStorey.set(elementId, expressId);
        // Propagate the storey assignment to aggregated descendants (e.g. an
        // IfcBuildingElementPart child of an IfcWall). Without this, parts have no
        // reverse-lookup entry even though the renderer emits them as standalone
        // meshes. Direct storey containment wins (only set if not already mapped);
        // `seen` guards against aggregate cycles.
        const stack: number[] = [elementId];
        const seen = new Set<number>([elementId]);
        while (stack.length > 0) {
          const current = stack.pop() as number;
          const aggregatedKids = relationships.getRelated(current, RelationshipType.Aggregates, 'forward');
          for (const kid of aggregatedKids) {
            if (seen.has(kid)) continue;
            seen.add(kid);
            if (!ctx.elementToStorey.has(kid)) {
              ctx.elementToStorey.set(kid, expressId);
            }
            stack.push(kid);
          }
        }
      }
      // Map the storey's spatial children (IfcSpace / IfcSpatialZone) to it too, so
      // a selected space resolves "which storey it's on" - the space is a child
      // node, not in containedElements (#1075).
      for (const childId of spatialChildIds) {
        if (!ctx.elementToStorey.has(childId)) {
          ctx.elementToStorey.set(childId, expressId);
        }
      }
    }

    // Attribute every directly-contained element AND its aggregated descendants
    // to THIS spatial container, at ANY level - not just storeys. This is what
    // lets the "immediate Container" lookup resolve a part nested through an
    // IfcElementAssembly under an IfcBridgePart / IfcRoadPart / IfcSpatialZone,
    // instead of leaving it blank. It is intentionally SEPARATE from the
    // storey-only `elementToStorey` above, whose semantics stay byte-identical.
    // Recursion visits inner containers before their parent, so the nearest
    // (innermost) container claims a shared descendant first.
    if (typeEnum !== IfcTypeEnum.IfcProject) {
      for (const elementId of containedElements) {
        ctx.elementToContainer.set(elementId, expressId);
        const stack: number[] = [elementId];
        const seen = new Set<number>([elementId]);
        while (stack.length > 0) {
          const current = stack.pop() as number;
          const aggregatedKids = relationships.getRelated(current, RelationshipType.Aggregates, 'forward');
          for (const kid of aggregatedKids) {
            if (seen.has(kid)) continue;
            seen.add(kid);
            if (!ctx.elementToContainer.has(kid)) {
              ctx.elementToContainer.set(kid, expressId);
            }
            stack.push(kid);
          }
        }
      }
    }

    return { expressId, type: typeEnum, name, longName, elevation, children: childNodes, elements: containedElements };
  }

  /**
   * Read an entity's LongName by schema attribute *name*. IfcSite / IfcBuilding /
   * IfcBuildingStorey / IfcSpace (and the IFC4.3 facility/infra containers)
   * declare LongName at index 7, but IfcProject carries it at a different slot,
   * so resolving by name (not a fixed index) stays correct across the IfcRoot
   * family. The lookup spans every bundled schema, so IFC4.3 leaves outside the
   * parser's IFC4 codegen pin resolve too. Returns the trimmed value, or
   * undefined when the type declares no LongName, it is empty, or no source
   * buffer is available (the buildFromCache path).
   */
  private extractLongName(expressId: number, ctx: BuildContext): string | undefined {
    if (!ctx.attrSource || !ctx.attrExtractor) return undefined;
    const ref = ctx.attrSource.entityIndex.byId.get(expressId);
    if (!ref) return undefined;
    try {
      const entity = ctx.attrExtractor.extractEntity(ref);
      if (!entity) return undefined;
      const idx = getAttributeNamesAcrossSchemas(entity.type).indexOf('LongName');
      if (idx < 0) return undefined;
      const raw = (entity.attributes || [])[idx];
      const value = typeof raw === 'string' ? raw.trim() : '';
      return value.length > 0 ? value : undefined;
    } catch (error) {
      log.caught('Failed to extract LongName', error, {
        operation: 'extractLongName',
        entityId: expressId,
      });
      return undefined;
    }
  }

  /**
   * Extract elevation from an IfcBuildingStorey. Elevation is attribute index 9
   * in both IFC2x3 and IFC4 (GlobalId, OwnerHistory, Name, Description,
   * ObjectType, ObjectPlacement, Representation, LongName, CompositionType,
   * Elevation).
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

      // Number from a raw value or a typed value like ['IFCLENGTHMEASURE', 3.0].
      const extractNumber = (val: any): number | undefined => {
        if (typeof val === 'number') return val;
        if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') {
          return val[1];
        }
        return undefined;
      };

      // Read ONLY slot 9: a previous "scan every attribute for a number < 10000"
      // fallback wrongly treated reference attributes (parsed as bare express-id
      // numbers, e.g. OwnerHistory #3628 -> 3628) as elevations, so a storey with
      // a null Elevation got a garbage value instead of falling through to the
      // ObjectPlacement-Z fallback below (#1289).
      if (attrs.length > 9) {
        return extractNumber(attrs[9]);
      }
    } catch (error) {
      log.caught('Failed to extract elevation', error, {
        operation: 'extractElevation',
        entityId: expressId,
        entityType: 'IfcBuildingStorey',
      });
    }

    return undefined;
  }

  /**
   * Resolve a storey's elevation from its ObjectPlacement, used as a fallback when
   * the Elevation attribute is null. Walks
   *   IfcBuildingStorey.ObjectPlacement (IfcLocalPlacement)
   *     -> RelativePlacement (IfcAxis2Placement3D)
   *       -> Location (IfcCartesianPoint).Coordinates[2]
   * i.e. the storey's Z relative to its parent spatial container, which matches
   * the semantics of the Elevation attribute and avoids folding in any site-level
   * georeferencing Z. Returns the raw (unscaled) Z, or undefined when the chain
   * can't be resolved.
   */
  private extractPlacementElevation(
    expressId: number,
    source: Uint8Array,
    entityIndex: { byId: { get(expressId: number): EntityRef | undefined } }
  ): number | undefined {
    try {
      const extractor = new EntityExtractor(source);
      const readAttrs = (id: number): unknown[] | undefined => {
        const ref = entityIndex.byId.get(id);
        if (!ref) return undefined;
        return extractor.extractEntity(ref)?.attributes ?? undefined;
      };

      // IfcBuildingStorey.ObjectPlacement is attribute index 5.
      const placementId = readAttrs(expressId)?.[5];
      if (typeof placementId !== 'number') return undefined;

      // IfcLocalPlacement(PlacementRelTo, RelativePlacement) - RelativePlacement
      // (index 1) is the IfcAxis2Placement3D carrying this storey's own offset.
      const axisId = readAttrs(placementId)?.[1];
      if (typeof axisId !== 'number') return undefined;

      // IfcAxis2Placement3D(Location, Axis, RefDirection) - Location (index 0) is
      // an IfcCartesianPoint.
      const locationId = readAttrs(axisId)?.[0];
      if (typeof locationId !== 'number') return undefined;

      // IfcCartesianPoint.Coordinates (index 0) is a list [x, y, z].
      const coords = readAttrs(locationId)?.[0];
      if (Array.isArray(coords) && coords.length >= 3 && typeof coords[2] === 'number') {
        return coords[2];
      }
    } catch (error) {
      log.caught('Failed to extract placement elevation', error, {
        operation: 'extractPlacementElevation',
        entityId: expressId,
        entityType: 'IfcBuildingStorey',
      });
    }

    return undefined;
  }
}
