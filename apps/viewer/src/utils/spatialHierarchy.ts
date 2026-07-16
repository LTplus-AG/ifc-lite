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
 * Classify a spatial node into the federation-identity container level it
 * represents, or null when it is none of those. The single home for the
 * site / building-like / project rules (building-like spans IFC4X3 facilities),
 * shared by `buildSpatialAncestryIndex` and `collectSpatialContainerNames` so
 * the classification can never drift between them.
 */
function spatialContainerLevel(node: SpatialNode): 'site' | 'building' | 'project' | null {
  if (node.type === IfcTypeEnum.IfcSite) return 'site';
  if (isBuildingLikeSpatialType(node.type)) return 'building';
  if (node.type === IfcTypeEnum.IfcProject) return 'project';
  return null;
}

/**
 * Collect the distinct REAL IFC names of every IfcSite / building-like /
 * IfcProject container in a hierarchy (unnamed containers contribute nothing,
 * matching the column values). `getName` resolves an entity's real Name.
 * `containers` gathers the name of every node that DIRECTLY contains elements
 * at any level — the immediate-Container column's possible values (storeys,
 * spaces / zones, IfcBridgePart / IfcRoadPart, …). Powers the spatial-filter
 * value suggestions, sharing node classification with `buildSpatialAncestryIndex`.
 */
export function collectSpatialContainerNames(
  hierarchy: SpatialHierarchy | undefined | null,
  getName: (expressId: number) => string,
): { sites: string[]; buildings: string[]; projects: string[]; containers: string[] } {
  const sites = new Set<string>();
  const buildings = new Set<string>();
  const projects = new Set<string>();
  const containers = new Set<string>();
  const root = hierarchy?.project;
  if (root) {
    const walk = (node: SpatialNode): void => {
      const name = getName(node.expressId);
      if (name) {
        const level = spatialContainerLevel(node);
        if (level === 'site') sites.add(name);
        else if (level === 'building') buildings.add(name);
        else if (level === 'project') projects.add(name);
        // Any node that directly lists elements is an immediate Container.
        if (node.elements.length > 0) containers.add(name);
      }
      for (const child of node.children) walk(child);
    };
    walk(root);
  }
  const sorted = (s: Set<string>) => Array.from(s).sort();
  return {
    sites: sorted(sites),
    buildings: sorted(buildings),
    projects: sorted(projects),
    containers: sorted(containers),
  };
}

/**
 * Nearest-ancestor spatial identity for an element, resolved from a built
 * spatial hierarchy. `siteOf` / `buildingOf` return the containing IfcSite /
 * IfcBuilding name (or '' when the element is unplaced, or the nearest such
 * container is unnamed); `projectName` is the model's single IfcProject name.
 */
export interface SpatialAncestryIndex {
  projectName: string;
  siteOf(elementId: number): string;
  buildingOf(elementId: number): string;
  /**
   * Name of the element's IMMEDIATE spatial container — the direct
   * IfcRelContainedInSpatialStructure parent (the node that lists it in its
   * `elements`), which may be a storey OR a non-storey container such as an
   * IfcBridgePart / IfcRoadPart / IfcSpatialZone / IfcSpace. Falls back to the
   * container's IFC class when it is unnamed (via `getClass`), and to '' when
   * the element is uncontained. Spaces and aggregated parts, which are not
   * directly contained, resolve to their storey (their nearest container).
   */
  containerOf(elementId: number): string;
}

/**
 * Precompute each element's containing IfcSite / IfcBuilding name from a spatial
 * hierarchy in a single depth-first pass, so a per-element lookup is O(1) and
 * never re-walks the tree. Used by federated views (Lists columns, panels) to
 * label which project / site / building an element belongs to.
 *
 * `getName` resolves an entity's real IFC `Name` — pass the store's
 * `entities.getName` so an UNNAMED container resolves to '' (matching how the
 * storey column behaves), rather than the `SpatialNode.name` placeholder the
 * hierarchy builder synthesizes (`Entity #N`). `getClass` (optional) resolves an
 * entity's IFC class name, used only as the `containerOf` fallback for an
 * unnamed immediate container. "Building" spans every
 * building-like spatial type (IFC4X3 IfcFacility / IfcBridge / IfcRoad / …), so
 * infrastructure federations resolve too.
 *
 * Coverage: elements listed directly under a container node (`node.elements`)
 * resolve via that node; a spatial container queried by its own id resolves to
 * its own site/building; parts and other aggregated descendants reachable only
 * through the storey reverse index (`elementToStorey`) resolve via their
 * storey. Elements the hierarchy doesn't place resolve to ''.
 */
export function buildSpatialAncestryIndex(
  hierarchy: SpatialHierarchy | undefined | null,
  getName: (expressId: number) => string,
  getClass?: (expressId: number) => string,
): SpatialAncestryIndex {
  // container node id -> nearest {site, building} name (self-inclusive).
  const ancestry = new Map<number, { site: string; building: string }>();
  // element id -> the container node that directly lists it in `elements`.
  const elementToContainer = new Map<number, number>();
  let projectName = '';

  if (hierarchy?.project) {
    const root = hierarchy.project;
    projectName = getName(root.expressId) || '';
    const walk = (node: SpatialNode, site: string, building: string): void => {
      // A site / building-like node takes its OWN name (or '' when unnamed). It
      // does NOT inherit the ancestor's name across same-type nesting: an
      // unnamed IfcSite nested in a named IfcSite is a different, unnamed site,
      // so it resolves to '' (consistent with the storey column), not the outer
      // name. Non-container nodes (storeys, spaces) propagate the parent's.
      const level = spatialContainerLevel(node);
      const nextSite = level === 'site' ? getName(node.expressId) : site;
      const nextBuilding = level === 'building' ? getName(node.expressId) : building;
      ancestry.set(node.expressId, { site: nextSite, building: nextBuilding });
      for (const el of node.elements) {
        if (!elementToContainer.has(el)) elementToContainer.set(el, node.expressId);
      }
      for (const child of node.children) walk(child, nextSite, nextBuilding);
    };
    walk(root, '', '');
  }

  const containerFor = (elementId: number): number | undefined => {
    if (ancestry.has(elementId)) return elementId; // the element IS a spatial container
    const direct = elementToContainer.get(elementId);
    if (direct !== undefined) return direct;
    return hierarchy?.elementToStorey.get(elementId); // parts/aggregated descendants
  };

  // Immediate container: the node that DIRECTLY lists the element in its
  // `elements` (IfcRelContainedInSpatialStructure), at whatever spatial level.
  // Unlike `containerFor`, the element itself is never its own container.
  // Aggregated parts (e.g. an IfcBeam nested through an IfcElementAssembly) are
  // not directly contained, so they resolve via the builder's
  // `elementToContainer` map — their nearest containing spatial node at any
  // level (a storey, but also an IfcBridgePart / IfcRoadPart / IfcSpatialZone).
  // Spaces (child nodes) fall back to their storey. `elementToStorey` remains
  // the final fallback so hierarchies that predate `elementToContainer` still
  // resolve parts under a storey.
  const immediateContainerFor = (elementId: number): number | undefined => {
    const direct = elementToContainer.get(elementId);
    if (direct !== undefined) return direct;
    const aggregated = hierarchy?.elementToContainer?.get(elementId);
    if (aggregated !== undefined) return aggregated;
    return hierarchy?.elementToStorey.get(elementId);
  };

  return {
    projectName,
    siteOf(elementId: number): string {
      const c = containerFor(elementId);
      return c === undefined ? '' : (ancestry.get(c)?.site ?? '');
    },
    buildingOf(elementId: number): string {
      const c = containerFor(elementId);
      return c === undefined ? '' : (ancestry.get(c)?.building ?? '');
    },
    containerOf(elementId: number): string {
      const c = immediateContainerFor(elementId);
      if (c === undefined) return '';
      // Real IFC Name, else the container's IFC class (e.g. "IfcBridgePart").
      return getName(c) || (getClass ? getClass(c) : '');
    },
  };
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
  /** element/type expressId -> associated material definition expressIds.
   *  A list so multiple IfcRelAssociatesMaterial on one element are preserved,
   *  matching the columnar parser's map shape. */
  onDemandMaterialMap: Map<number, number[]>;
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
  const onDemandMaterialMap = new Map<number, number[]>();

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
          // Preserve every association (multiple IfcRelAssociatesMaterial on one
          // element are valid), matching the columnar parser's list-valued map.
          let list = onDemandMaterialMap.get(entityId);
          if (!list) { list = []; onDemandMaterialMap.set(entityId, list); }
          list.push(materialId);
        }
      }
    }
  }

  console.log(
    `[spatialHierarchy] Rebuilt on-demand maps: ${propertySets.length} psets, ${quantitySets.length} qsets, ${materialDefCount} material defs -> ${onDemandPropertyMap.size} entities with properties, ${onDemandQuantityMap.size} with quantities, ${onDemandMaterialMap.size} with materials`
  );
  return { onDemandPropertyMap, onDemandQuantityMap, onDemandMaterialMap };
}
