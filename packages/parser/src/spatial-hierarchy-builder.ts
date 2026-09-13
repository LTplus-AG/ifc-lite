/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial hierarchy builder - builds the project/site/building/storey tree.
 *
 * Single source for spatial-hierarchy construction, over one shared
 * `buildNode`: `build(...)` (fresh parse, extracts storey elevations, throws
 * if there is no IfcProject) and `buildFromCache` (no source so elevations
 * stay empty, returns undefined if there is no IfcProject) share the same
 * cycle guard, canonical-parent resolution, storey mapping, and spatial-child
 * promotion, so they cannot drift.
 */

import type { EntityTable, StringTable, RelationshipGraph, SpatialHierarchy, SpatialNode } from '@ifc-lite/data';
import {
  IfcTypeEnum,
  RelationshipType,
  isBuildingLikeSpatialType,
  isSpaceLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
  findStoreyByElevation,
  spatialLookups,
} from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import type { IfcSourceBytes } from './source-bytes.js';
import { computeCanonicalParent, computeReachableSpatialNodes } from './spatial-hierarchy-canonical-parent.js';
import {
  type AttributeSource,
  extractLongName,
  extractElevation,
  extractPlacementElevation,
} from './spatial-hierarchy-attributes.js';
import { computeAmbiguousStorey } from './spatial-hierarchy-ambiguity.js';

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
   *  SpatialHierarchy field docs); covers aggregated descendants too, unlike `elementToStorey`. */
  elementToContainer: Map<number, number>;
  visited: Set<number>;
  canonicalParent: Map<number, number>; // childId -> its one allowed builder (#4095)
  /** Spatial-structure nodes buildNode will actually visit from IfcProject
   *  (see computeReachableSpatialNodes) - set once IfcProject is known, #4310. */
  reachableSpatialNodes: Set<number>;
  attrSource?: AttributeSource;
  /** One extractor reused across the recursion so LongName reads don't re-allocate per node. */
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
    source: Uint8Array | IfcSourceBytes,
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
      canonicalParent: computeCanonicalParent(entities, relationships),
      reachableSpatialNodes: new Set(), // filled in below once IfcProject is known
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

    // Which storeys buildNode will actually recurse into, computed up front
    // so ContainsElements resolution below never depends on this node's own
    // position in the traversal (#4310) - see computeReachableSpatialNodes.
    ctx.reachableSpatialNodes = computeReachableSpatialNodes(projectIds[0], ctx.canonicalParent);

    const projectNode = this.buildNode(projectIds[0], ctx);

    if (ctx.byStorey.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No storeys found in spatial hierarchy');
    }
    if (ctx.byBuilding.size === 0) {
      console.warn('[SpatialHierarchyBuilder] No buildings found in spatial hierarchy');
    }

    const { byStorey, byBuilding, bySite, bySpace, storeyElevations, elementToStorey, elementToContainer } = ctx;


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
      ambiguousStorey: computeAmbiguousStorey(byStorey), // #4311

      getStoreyElements(storeyId: number): number[] {
        return byStorey.get(storeyId) ?? [];
      },

      getStoreyByElevation(z: number): number | null {
        // With an empty storeyElevations map (cache path) this returns null.
        // Shared with the server-loaded path in the viewer (#1841) so the same
        // Z can never resolve to a different storey depending on entry path.
        return findStoreyByElevation(storeyElevations, z);
      },

      ...spatialLookups(projectNode, bySpace, elementToContainer),
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
    const rawLongName = extractLongName(expressId, ctx.attrSource, ctx.attrExtractor);
    // Fall back to LongName when Name is empty (common for IfcSpace). Left
    // empty, not a fabricated `Entity #<id>` — it flows into the export layer.
    const name = rawName || rawLongName || '';
    // Only keep LongName as a distinct descriptor when it adds something beyond
    // the primary label (never duplicate it into the secondary slot).
    const longName = rawLongName && rawLongName !== name ? rawLongName : undefined;

    // This is NOT what actually prevents unbounded recursion on a cyclic
    // IfcRelAggregates chain (A aggregates B, B aggregates A) - it never
    // fires today. Recursion here only ever follows a node's ONE canonical
    // parent (computeCanonicalParent in spatial-hierarchy-canonical-parent.ts
    // picks exactly one, and skips any candidate that would close a cycle
    // back through the child, #4246), so a cycle can supply at most one
    // recursion edge into any node - which structurally cannot loop. Kept as
    // defence in depth in case that single-parent invariant is ever
    // weakened; if it does fire, a revisited node is returned as a leaf so
    // the rest of the hierarchy still builds.
    if (ctx.visited.has(expressId)) {
      return { expressId, type: typeEnum, name, longName, elevation: undefined, children: [], elements: [] };
    }
    ctx.visited.add(expressId);

    // Storey elevation (fresh path only): apply unit scale to convert to meters.
    let elevation: number | undefined;
    if (typeEnum === IfcTypeEnum.IfcBuildingStorey && ctx.attrSource) {
      const { source, entityIndex, lengthUnitScale } = ctx.attrSource;
      let rawElevation = extractElevation(expressId, source, entityIndex);
      if (rawElevation === undefined) {
        // Elevation is optional and frequently null (Revit / ArchiCAD). Fall back
        // to the storey's Z from its ObjectPlacement so it still orders + lifts in
        // Exploded mode instead of collapsing to a single floor (#1289).
        rawElevation = extractPlacementElevation(expressId, source, entityIndex);
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
        if (ctx.canonicalParent.get(childId) !== expressId) return; // canonical parent only, no phantom stub (#4095)
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
        // First-declared wins on duplicate containment, matching containedIn()
        // (#4248) - but only among storeys buildNode actually visits. A
        // first-declared edge naming an unreachable storey (no path back to
        // IfcProject, e.g. missing its own IfcRelAggregates edge) is not a
        // real competing answer: buildNode never runs that storey's own
        // branch, so nothing would ever claim the element there, and the
        // element must not be dropped just because a later-declared but
        // VIABLE storey lost a tie to a candidate that can't win (#4310).
        // Only storey-like containers compete: a reachable IfcSpace edge
        // declared first is not a storey answer, and letting it win here
        // would leave the element with no elementToStorey entry at all
        // (spaces never run this branch).
        const containerEdges = relationships.inverse.getEdges(elementId, RelationshipType.ContainsElements);
        const firstViableContainer = containerEdges.find((edge) =>
          ctx.reachableSpatialNodes.has(edge.target) && isStoreyLikeSpatialType(entities.getTypeEnum(edge.target)));
        // expressId is always reachable here (buildNode only runs on reachable
        // nodes) and always has an edge to elementId (elementId came from THIS
        // storey's own containedElements), so firstViableContainer is always
        // defined - it can never fall through to the pre-#4310 "assign
        // unconditionally" behavior by surprise.
        if (firstViableContainer && firstViableContainer.target !== expressId) continue; // a viable earlier-declared storey wins instead
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
}
