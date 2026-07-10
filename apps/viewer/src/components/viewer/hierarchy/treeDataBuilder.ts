/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IfcTypeEnum,
  EntityFlags,
  RelationshipType,
  isSpaceLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
  type SpatialNode,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { buildMaterialUsageIndex, extractGroupMembersOnDemand } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import {
  collectAggregatedDescendants,
  getAggregatedChildren,
  type AggregationRelationships,
} from '@/utils/aggregation';
import type { TreeNode, NodeType, StoreyData, UnifiedStorey, HierarchySortMode } from './types';
import { DEFAULT_HIERARCHY_SORT } from './types';

/** Helper to create elevation key (with 0.5m tolerance for matching) */
export function elevationKey(elevation: number): string {
  return (Math.round(elevation * 2) / 2).toFixed(2);
}

/** "Level" rows the browser sorts: building storeys plus their IFC4.3
 *  facility-part equivalents (facility / bridge / road / railway parts). These
 *  are the elevation-bearing leaf containers under a building or facility, so
 *  they share the storey sort; other spatial children (Site, Building, Space)
 *  keep their document order. `isStoreyLikeSpatialType` covers only
 *  IfcBuildingStorey, hence the explicit part types here. */
function isLevelLikeSpatialType(type: IfcTypeEnum): boolean {
  return (
    isStoreyLikeSpatialType(type) ||
    type === IfcTypeEnum.IfcFacilityPart ||
    type === IfcTypeEnum.IfcBridgePart ||
    type === IfcTypeEnum.IfcRoadPart ||
    type === IfcTypeEnum.IfcRailwayPart
  );
}

/** Natural, case-insensitive name collation so "Level 2" sorts before "Level 10". */
const storeyNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Order two storey-like entries (unified storeys or spatial nodes) by the
 *  browser sort mode chosen in the hierarchy panel (issue #1296). */
export function compareStoreyEntries(
  a: { name: string; elevation?: number },
  b: { name: string; elevation?: number },
  mode: HierarchySortMode,
): number {
  switch (mode) {
    case 'elevation-asc':
      return (a.elevation ?? 0) - (b.elevation ?? 0);
    case 'name-asc':
      return storeyNameCollator.compare(a.name, b.name);
    case 'name-desc':
      return storeyNameCollator.compare(b.name, a.name);
    case 'elevation-desc':
    default:
      return (b.elevation ?? 0) - (a.elevation ?? 0);
  }
}

/** The name a spatial element row renders with: its entity name, or a
 *  "<Type> #<id>" fallback. Single source of truth so the displayed label
 *  (emitElementSubtree) and the name-sort key (orderElementIdsByName) can't
 *  drift apart. Callers that already resolved the type name pass it as
 *  `typeName` so the fallback branch does not fetch it a second time. */
function getElementDisplayName(id: number, dataStore: IfcDataStore, typeName?: string): string {
  const entities = dataStore.entities;
  const name = entities?.getName(id);
  if (name) return name;
  return `${typeName || entities?.getTypeName(id) || 'Unknown'} #${id}`;
}

/** Order the element rows within a spatial container by the active browser sort
 *  (issue #1476). A name sort orders elements by the same visible name the row
 *  renders (`getName || "<Type> #<id>"`), using the natural-numeric collator so
 *  "W-2" sorts before "W-10"; this makes the sort reach INSIDE a storey, not just
 *  the storey rows — the whole point of the reported bug (one storey means the
 *  storey sort is a no-op). Elevation modes keep the as-modeled document order, since
 *  individual elements carry no elevation. Returns the input array unchanged (not
 *  a copy) when nothing to reorder, so callers must treat the result as readonly.
 *  `Array.prototype.sort` is stable, so equal-named elements keep document order. */
function orderElementIdsByName(
  elementIds: number[],
  dataStore: IfcDataStore,
  mode: HierarchySortMode,
): number[] {
  if ((mode !== 'name-asc' && mode !== 'name-desc') || elementIds.length < 2) {
    return elementIds;
  }
  const dir = mode === 'name-desc' ? -1 : 1;
  // Decorate-sort-undecorate: resolve each display name exactly once rather than
  // O(n log n) times inside the comparator.
  return elementIds
    .map((id) => ({ id, name: getElementDisplayName(id, dataStore) }))
    .sort((a, b) => dir * storeyNameCollator.compare(a.name, b.name))
    .map((e) => e.id);
}

/** Convert IfcTypeEnum to NodeType string */
export function getNodeType(ifcType: IfcTypeEnum): NodeType {
  switch (ifcType) {
    case IfcTypeEnum.IfcProject: return 'IfcProject';
    case IfcTypeEnum.IfcSite: return 'IfcSite';
    case IfcTypeEnum.IfcBuilding: return 'IfcBuilding';
    case IfcTypeEnum.IfcFacility: return 'IfcFacility';
    case IfcTypeEnum.IfcBridge: return 'IfcBridge';
    case IfcTypeEnum.IfcRoad: return 'IfcRoad';
    case IfcTypeEnum.IfcRailway: return 'IfcRailway';
    case IfcTypeEnum.IfcMarineFacility: return 'IfcMarineFacility';
    case IfcTypeEnum.IfcBuildingStorey: return 'IfcBuildingStorey';
    case IfcTypeEnum.IfcFacilityPart: return 'IfcFacilityPart';
    case IfcTypeEnum.IfcBridgePart: return 'IfcBridgePart';
    case IfcTypeEnum.IfcRoadPart: return 'IfcRoadPart';
    case IfcTypeEnum.IfcRailwayPart: return 'IfcRailwayPart';
    case IfcTypeEnum.IfcSpace: return 'IfcSpace';
    case IfcTypeEnum.IfcSpatialZone: return 'IfcSpatialZone';
    default: return 'element';
  }
}

function resolveTreeGlobalId(
  modelId: string,
  expressId: number,
  models: Map<string, FederatedModel>
): number {
  if (modelId === 'legacy' || !models.has(modelId)) {
    return expressId;
  }

  return useViewerStore.getState().toGlobalId(modelId, expressId);
}

function collectDescendantSpaceElements(
  spatialNode: SpatialNode,
  hierarchy: IfcDataStore['spatialHierarchy'],
  cache: Map<number, Set<number>>
): Set<number> {
  const cached = cache.get(spatialNode.expressId);
  if (cached) return cached;

  const elementIds = new Set<number>();

  for (const child of spatialNode.children || []) {
    // IfcSpace and IfcSpatialZone both roll up their bySpace elements so the
    // storey doesn't also list them as direct contained elements (#1075).
    if (isSpaceLikeSpatialType(child.type)) {
      for (const elementId of hierarchy?.bySpace.get(child.expressId) ?? []) {
        elementIds.add(elementId);
      }
    }

    for (const elementId of collectDescendantSpaceElements(child, hierarchy, cache)) {
      elementIds.add(elementId);
    }
  }

  cache.set(spatialNode.expressId, elementIds);
  return elementIds;
}

function getSpatialNodeElements(
  spatialNode: SpatialNode,
  dataStore: IfcDataStore,
  nodeType: NodeType,
  descendantSpaceCache: Map<number, Set<number>>
): number[] {
  if (isSpaceLikeSpatialType(spatialNode.type)) {
    return (dataStore.spatialHierarchy?.bySpace.get(spatialNode.expressId) as number[]) || [];
  }

  if (!isStoreyLikeSpatialType(spatialNode.type)) {
    if (!isSpatialStructureType(spatialNode.type)) {
      return [];
    }
    return spatialNode.elements || [];
  }

  if (nodeType !== 'IfcBuildingStorey') {
    return [];
  }

  const storeyElements =
    (dataStore.spatialHierarchy?.byStorey.get(spatialNode.expressId) as number[]) || [];
  const descendantSpaceElements = collectDescendantSpaceElements(
    spatialNode,
    dataStore.spatialHierarchy,
    descendantSpaceCache
  );

  return storeyElements.filter((elementId) => !descendantSpaceElements.has(elementId));
}

/** Build unified storey data for multi-model mode */
export function buildUnifiedStoreys(
  models: Map<string, FederatedModel>,
  sortMode: HierarchySortMode = DEFAULT_HIERARCHY_SORT,
): UnifiedStorey[] {
  if (models.size <= 1) return [];

  const storeysByElevation = new Map<string, UnifiedStorey>();

  for (const [modelId, model] of models) {
    const dataStore = model.ifcDataStore;
    if (!dataStore?.spatialHierarchy) continue;

    const hierarchy = dataStore.spatialHierarchy;
    const { byStorey, storeyElevations } = hierarchy;

    for (const [storeyId, elements] of byStorey.entries()) {
      const elevation = storeyElevations.get(storeyId) ?? 0;
      const name = dataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
      const key = elevationKey(elevation);

      const storeyData: StoreyData = {
        modelId,
        storeyId,
        name,
        elevation,
        elements: elements as number[],
      };

      if (storeysByElevation.has(key)) {
        const unified = storeysByElevation.get(key)!;
        unified.storeys.push(storeyData);
        unified.totalElements += elements.length;
        if (name.length < unified.name.length) {
          unified.name = name;
        }
      } else {
        storeysByElevation.set(key, {
          key,
          name,
          elevation,
          storeys: [storeyData],
          totalElements: elements.length,
        });
      }
    }
  }

  return Array.from(storeysByElevation.values())
    .sort((a, b) => compareStoreyEntries(a, b, sortMode));
}

/** Get all element IDs for a unified storey (as global IDs) - optimized to avoid spread operator */
export function getUnifiedStoreyElements(
  unifiedStorey: UnifiedStorey,
  models: Map<string, FederatedModel>
): number[] {
  // Pre-calculate total length for single allocation
  const totalLength = unifiedStorey.storeys.reduce((sum, s) => sum + s.elements.length, 0);
  const allElements = new Array<number>(totalLength);
  let idx = 0;
  for (const storey of unifiedStorey.storeys) {
    for (const id of storey.elements) {
      allElements[idx++] = resolveTreeGlobalId(storey.modelId, id, models);
    }
  }
  return allElements;
}

/**
 * Emit one element row and, if it decomposes via `IfcRelAggregates`, its parts
 * nested underneath (recursively). A decomposing assembly — an
 * `IfcElementAssembly`, or an `IfcStair`/`IfcRoof`/`IfcRamp` used as a container
 * — appears in the spatial tree as a leaf contained in its storey, while its
 * stair flights / railings / landing slabs / virtual clearance volumes hang off
 * it via aggregation and hold the actual geometry. Without nesting, those parts
 * were absent from the spatial panel and the assembly was unselectable
 * (issue #1133).
 *
 * `ancestors` is the aggregation path from the storey-level element down to
 * here, used to break malformed `IfcRelAggregates` cycles.
 */
function emitElementSubtree(
  elementId: number,
  modelId: string,
  models: Map<string, FederatedModel>,
  dataStore: IfcDataStore,
  depth: number,
  expandedNodes: Set<string>,
  nodes: TreeNode[],
  ancestors: Set<number>,
  sortMode: HierarchySortMode,
): void {
  const relationships = dataStore.relationships as AggregationRelationships | undefined;
  const globalId = resolveTreeGlobalId(modelId, elementId, models);
  const entityType = dataStore.entities?.getTypeName(elementId) || 'Unknown';
  // Reuse entityType so an unnamed element resolves its type name only once.
  const entityName = getElementDisplayName(elementId, dataStore, entityType);

  // Direct decomposition children, minus anything already on the path (cycle
  // guard), ordered by the active name sort so it reaches inside a decomposing
  // assembly too, not just the storey rows (issue #1476).
  const childIds = orderElementIdsByName(
    getAggregatedChildren(relationships, elementId).filter(
      (id) => id !== elementId && !ancestors.has(id),
    ),
    dataStore,
    sortMode,
  );
  const hasChildren = childIds.length > 0;
  const nodeId = `element-${modelId}-${elementId}`;
  const isExpanded = hasChildren && expandedNodes.has(nodeId);

  // All descendant parts carry the geometry — stash their global IDs so a click
  // on the (geometry-less) assembly can highlight / frame / isolate the whole
  // thing at once, even while the row is collapsed.
  const assemblyChildGlobalIds = hasChildren
    ? collectAggregatedDescendants(relationships, elementId).map((id) =>
        resolveTreeGlobalId(modelId, id, models),
      )
    : undefined;

  nodes.push({
    id: nodeId,
    expressIds: [elementId],
    globalIds: [globalId],
    modelIds: [modelId],
    name: entityName,
    type: 'element',
    ifcType: entityType,
    depth,
    hasChildren,
    isExpanded,
    isVisible: true, // Computed lazily during render
    elementCount: hasChildren ? childIds.length : undefined,
    assemblyChildGlobalIds,
  });

  if (isExpanded) {
    const nextAncestors = new Set(ancestors).add(elementId);
    for (const childId of childIds) {
      emitElementSubtree(childId, modelId, models, dataStore, depth + 1, expandedNodes, nodes, nextAncestors, sortMode);
    }
  }
}

/** Recursively build spatial nodes (Project -> Site -> Building) */
function buildSpatialNodes(
  spatialNode: SpatialNode,
  modelId: string,
  models: Map<string, FederatedModel>,
  dataStore: IfcDataStore,
  depth: number,
  parentNodeId: string,
  stopAtBuilding: boolean,
  idOffset: number,
  expandedNodes: Set<string>,
  nodes: TreeNode[],
  descendantSpaceCache: Map<number, Set<number>>,
  sortMode: HierarchySortMode
): void {
  const nodeId = `${parentNodeId}-${spatialNode.expressId}`;
  const nodeType = getNodeType(spatialNode.type);
  const isNodeExpanded = expandedNodes.has(nodeId);

  // Skip storeys in multi-model mode (they're shown in unified list)
  if (stopAtBuilding && nodeType === 'IfcBuildingStorey') {
    return;
  }

  const elements = getSpatialNodeElements(spatialNode, dataStore, nodeType, descendantSpaceCache);
  const hasDirectElements = elements.length > 0;

  // Primary label: the entity Name, falling back to the type when absent
  // ("unknown"). LongName rides alongside as a muted secondary so an ISO 19650
  // code and its meaning read together, e.g. "01" + "Main Residence" (#1634).
  const primaryName = (spatialNode.name && spatialNode.name.toLowerCase() !== 'unknown')
    ? spatialNode.name
    : nodeType;
  const secondaryName =
    spatialNode.longName && spatialNode.longName !== primaryName
      ? spatialNode.longName
      : undefined;

  // Check if has children
  // In stopAtBuilding mode, buildings have no children (storeys shown separately)
  const hasNonStoreyChildren = spatialNode.children?.some(
    (c: SpatialNode) => !isStoreyLikeSpatialType(c.type)
  );
  const hasChildren = stopAtBuilding
    ? Boolean(hasNonStoreyChildren || hasDirectElements)
    : (spatialNode.children?.length > 0) || hasDirectElements;

  nodes.push({
    id: nodeId,
    expressIds: [spatialNode.expressId],
    globalIds: [resolveTreeGlobalId(modelId, spatialNode.expressId, models)],
    modelIds: [modelId],
    name: primaryName,
    secondaryName,
    type: nodeType,
    depth,
    hasChildren,
    isExpanded: isNodeExpanded,
    isVisible: true, // Visibility computed lazily during render
    elementCount: hasDirectElements ? elements.length : undefined,
    storeyElevation: spatialNode.elevation,
    // Store idOffset for lazy visibility computation
    _idOffset: idOffset,
  });

  if (isNodeExpanded) {
    // Reorder the level-like children (storeys + facility parts) by the chosen
    // browser sort mode (#1296), sorting only those rows IN PLACE so non-level
    // siblings (Site, Building, Space) keep their document position.
    const children = spatialNode.children || [];
    const levelChildren = children.filter((child) => isLevelLikeSpatialType(child.type));
    let sortedChildren = children;
    if (levelChildren.length > 1) {
      const sortedLevels = [...levelChildren].sort((a, b) => compareStoreyEntries(a, b, sortMode));
      let li = 0;
      sortedChildren = children.map((child) =>
        isLevelLikeSpatialType(child.type) ? sortedLevels[li++] : child,
      );
    }

    for (const child of sortedChildren) {
      buildSpatialNodes(
        child,
        modelId,
        models,
        dataStore,
        depth + 1,
        nodeId,
        stopAtBuilding,
        idOffset,
        expandedNodes,
        nodes,
        descendantSpaceCache,
        sortMode
      );
    }

    // Add direct spatial children elements for expanded nodes — each may itself
    // decompose into nested parts via IfcRelAggregates (issue #1133). Order them
    // by the active name sort so it reaches inside the storey/space, not just the
    // storey rows (issue #1476).
    if (hasDirectElements) {
      const orderedElements = orderElementIdsByName(elements, dataStore, sortMode);
      for (const elementId of orderedElements) {
        emitElementSubtree(elementId, modelId, models, dataStore, depth + 1, expandedNodes, nodes, new Set(), sortMode);
      }
    }
  }
}

/** Build the complete tree data structure */
export function buildTreeData(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: Set<string>,
  isMultiModel: boolean,
  unifiedStoreys: UnifiedStorey[],
  sortMode: HierarchySortMode = DEFAULT_HIERARCHY_SORT
): TreeNode[] {
  const nodes: TreeNode[] = [];

  // Multi-model mode: unified storeys + MODELS section
  if (isMultiModel) {
    // 1. Add unified storeys at the top
    for (const unified of unifiedStoreys) {
      const storeyNodeId = `unified-${unified.key}`;
      const isExpanded = expandedNodes.has(storeyNodeId);
      const allStoreyIds = unified.storeys.map(s => s.storeyId);

      nodes.push({
        id: storeyNodeId,
        expressIds: allStoreyIds,
        globalIds: unified.storeys.map((s) => toGlobalIdFromModels(models, s.modelId, s.storeyId)),
        modelIds: unified.storeys.map(s => s.modelId),
        name: unified.name,
        type: 'unified-storey',
        depth: 0,
        hasChildren: unified.totalElements > 0,
        isExpanded,
        isVisible: true, // Computed lazily during render
        elementCount: unified.totalElements,
        storeyElevation: unified.elevation,
      });

      // If expanded, show elements grouped by model
      if (isExpanded) {
        for (const storey of unified.storeys) {
          const model = models.get(storey.modelId);
          const modelName = model?.name || storey.modelId;
          const offset = model?.idOffset ?? 0;

          // Add model contribution header
          const contribNodeId = `contrib-${storey.modelId}-${storey.storeyId}`;
          const contribExpanded = expandedNodes.has(contribNodeId);

          nodes.push({
            id: contribNodeId,
            expressIds: [storey.storeyId],
            globalIds: [resolveTreeGlobalId(storey.modelId, storey.storeyId, models)],
            modelIds: [storey.modelId],
            name: modelName,
            type: 'model-header',
            depth: 1,
            hasChildren: storey.elements.length > 0,
            isExpanded: contribExpanded,
            isVisible: true, // Computed lazily during render
            elementCount: storey.elements.length,
            _idOffset: offset,
          });

          // If contribution expanded, show elements (assemblies nest their
          // IfcRelAggregates parts — issue #1133), ordered by the active name
          // sort so it reaches inside the storey (issue #1476).
          if (contribExpanded && model?.ifcDataStore) {
            const orderedElements = orderElementIdsByName(storey.elements, model.ifcDataStore, sortMode);
            for (const elementId of orderedElements) {
              emitElementSubtree(elementId, storey.modelId, models, model.ifcDataStore, 2, expandedNodes, nodes, new Set(), sortMode);
            }
          }
        }
      }
    }

    // 2. Add MODELS section header
    nodes.push({
      id: 'models-header',
      expressIds: [],
      globalIds: [],
      modelIds: [],
      name: 'Models',
      type: 'model-header',
      depth: 0,
      hasChildren: false,
      isExpanded: false,
      isVisible: true,
    });

    // 3. Add each model with Project -> Site -> Building (NO storeys)
    for (const [modelId, model] of models) {
      const modelNodeId = `model-${modelId}`;
      const isModelExpanded = expandedNodes.has(modelNodeId);
      const hasSpatialHierarchy = model.ifcDataStore?.spatialHierarchy?.project !== undefined;

      nodes.push({
        id: modelNodeId,
        expressIds: [],
        globalIds: [],
        modelIds: [modelId],
        name: model.name,
        type: 'model-header',
        depth: 0,
        hasChildren: hasSpatialHierarchy,
        isExpanded: isModelExpanded,
        isVisible: model.visible,
        elementCount: model.ifcDataStore?.entityCount,
      });

      // If expanded, show Project -> Site -> Building (stop at building, no storeys)
      if (isModelExpanded && model.ifcDataStore?.spatialHierarchy?.project) {
        const descendantSpaceCache = new Map<number, Set<number>>();
        buildSpatialNodes(
          model.ifcDataStore.spatialHierarchy.project,
          modelId,
          models,
          model.ifcDataStore,
          1,
          modelNodeId,
          true,  // stopAtBuilding = true
          model.idOffset ?? 0,
          expandedNodes,
          nodes,
          descendantSpaceCache,
          sortMode
        );
      }
    }
  } else if (models.size === 1) {
    // Single model: show full spatial hierarchy (including storeys)
    const [modelId, model] = Array.from(models.entries())[0];
    if (model.ifcDataStore?.spatialHierarchy?.project) {
      const descendantSpaceCache = new Map<number, Set<number>>();
      buildSpatialNodes(
        model.ifcDataStore.spatialHierarchy.project,
        modelId,
        models,
        model.ifcDataStore,
        0,
        'root',
        false,  // stopAtBuilding = false (show full hierarchy)
        model.idOffset ?? 0,
        expandedNodes,
        nodes,
        descendantSpaceCache,
        sortMode
      );
    }
  } else if (ifcDataStore?.spatialHierarchy?.project) {
    // Legacy single-model mode (no offset)
    const descendantSpaceCache = new Map<number, Set<number>>();
    buildSpatialNodes(
      ifcDataStore.spatialHierarchy.project,
      'legacy',
      models,
      ifcDataStore,
      0,
      'root',
      false,
      0,
      expandedNodes,
      nodes,
      descendantSpaceCache,
      sortMode
    );
  }

  return nodes;
}

/** An authored (overlay) product to fold into the class/type trees — it lives in
 *  the mutation overlay, not the columnar parse those builders scan. */
export interface AuthoredProduct {
  modelId: string;
  expressId: number;
  globalId: number;
  name: string;
  ifcType: string;
}

/** Build tree data grouped by IFC class instead of spatial hierarchy.
 *  Only includes entities that have geometry (visible in the 3D viewer).
 *  @param geometricIds Pre-computed set of global IDs with geometry (memoized by caller).
 *  @param authoredProducts Overlay-authored products (e.g. a baked IfcSpace) that
 *    aren't in the columnar table but have geometry — folded into their class. */
export function buildTypeTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: Set<string>,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
  authoredProducts?: AuthoredProduct[],
): TreeNode[] {
  // Collect entities grouped by IFC class across all models
  const typeGroups = new Map<string, Array<{ expressId: number; globalId: number; name: string; modelId: string }>>();

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    for (let i = 0; i < dataStore.entities.count; i++) {
      const expressId = dataStore.entities.expressId[i];
      const globalId = resolveTreeGlobalId(modelId, expressId, models);

      // Only include entities that have geometry
      if (geometricIds && geometricIds.size > 0 && !geometricIds.has(globalId)) continue;

      const typeName = dataStore.entities.getTypeName(expressId) || 'Unknown';
      const entityName = dataStore.entities.getName(expressId) || `${typeName} #${expressId}`;

      if (!typeGroups.has(typeName)) {
        typeGroups.set(typeName, []);
      }
      typeGroups.get(typeName)!.push({ expressId, globalId, name: entityName, modelId });
    }
  };

  // Process all models
  if (models.size > 0) {
    for (const [modelId, model] of models) {
      if (model.ifcDataStore) {
        processDataStore(model.ifcDataStore, modelId);
      }
    }
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, 'legacy');
  }

  // Fold in authored (overlay) products — a baked IfcSpace, an added slab, … —
  // which the columnar scan above can't see, so they'd otherwise be absent from
  // the "By Class" tree even though they render in 3D.
  for (const p of authoredProducts ?? []) {
    let list = typeGroups.get(p.ifcType);
    if (!list) { list = []; typeGroups.set(p.ifcType, list); }
    if (!list.some((e) => e.globalId === p.globalId)) {
      list.push({ expressId: p.expressId, globalId: p.globalId, name: p.name, modelId: p.modelId });
    }
  }

  // Sort types alphabetically
  const sortedTypes = Array.from(typeGroups.keys()).sort();

  const nodes: TreeNode[] = [];
  for (const typeName of sortedTypes) {
    const entities = typeGroups.get(typeName)!;
    const groupNodeId = `type-${typeName}`;
    const isExpanded = expandedNodes.has(groupNodeId);

    // Store all globalIds on the group node so getNodeElements is O(1),
    // avoiding a full entity scan when the group is collapsed.
    const groupGlobalIds = entities.map(e => e.globalId);

    nodes.push({
      id: groupNodeId,
      expressIds: entities.map((e) => e.expressId),
      globalIds: groupGlobalIds,
      modelIds: [],
      name: typeName,
      type: 'type-group',
      ifcType: typeName,
      depth: 0,
      hasChildren: entities.length > 0,
      isExpanded,
      isVisible: true,
      elementCount: entities.length,
    });

    if (isExpanded) {
      // Sort elements by name within type group
      entities.sort((a, b) => a.name.localeCompare(b.name));
      for (const entity of entities) {
        const suffix = isMultiModel ? ` [${models.get(entity.modelId)?.name || entity.modelId}]` : '';
        nodes.push({
          id: `element-${entity.modelId}-${entity.expressId}`,
          expressIds: [entity.expressId],
          globalIds: [entity.globalId],
          modelIds: [entity.modelId],
          name: entity.name + suffix,
          type: 'element',
          ifcType: typeName,
          depth: 1,
          hasChildren: false,
          isExpanded: false,
          isVisible: true,
        });
      }
    }
  }

  return nodes;
}

/** Build tree data grouped by IFC type entities (IfcWallType, IfcDoorType, etc.).
 *  Shows each type entity as a parent node with its typed instances (occurrences) as children.
 *  Uses IfcRelDefinesByType relationships to find type→occurrence mappings.
 *  Entities without a type are grouped under an "Untyped" section per IFC class. */
export function buildIfcTypeTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: Set<string>,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
): TreeNode[] {
  // Collect type entities and their typed instances
  interface TypeEntry {
    typeExpressId: number;
    typeName: string;      // e.g. "W01"
    typeClassName: string;  // e.g. "IfcWallType"
    modelId: string;
    globalId: number;
    instances: Array<{ expressId: number; globalId: number; name: string; modelId: string; ifcType: string }>;
  }

  // Group by type class name (e.g. "IfcWallType") → individual types
  const typeClassGroups = new Map<string, TypeEntry[]>();

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    if (!dataStore.relationships) return;

    // Find all type entities (entities with IS_TYPE flag)
    for (let i = 0; i < dataStore.entities.count; i++) {
      const flags = dataStore.entities.flags[i];
      if (!(flags & EntityFlags.IS_TYPE)) continue;

      const expressId = dataStore.entities.expressId[i];
      const typeClassName = dataStore.entities.getTypeName(expressId);

      // Skip relationship entities and non-product types
      if (typeClassName.startsWith('IfcRel') || typeClassName === 'Unknown') continue;
      const typeName = dataStore.entities.getName(expressId) || `#${expressId}`;

      // Get instances via DefinesByType (forward: type → occurrences)
      const instanceIds = dataStore.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'forward');
      const instances: TypeEntry['instances'] = [];

      for (const instId of instanceIds) {
        const instGlobalId = resolveTreeGlobalId(modelId, instId, models);
        if (geometricIds && geometricIds.size > 0 && !geometricIds.has(instGlobalId)) continue;
        const instName = dataStore.entities.getName(instId) || `#${instId}`;
        const instIfcType = dataStore.entities.getTypeName(instId) || 'Unknown';
        instances.push({ expressId: instId, globalId: instGlobalId, name: instName, modelId, ifcType: instIfcType });
      }

      const entry: TypeEntry = {
        typeExpressId: expressId,
        typeName,
        typeClassName,
        modelId,
        globalId: resolveTreeGlobalId(modelId, expressId, models),
        instances,
      };

      if (!typeClassGroups.has(typeClassName)) {
        typeClassGroups.set(typeClassName, []);
      }
      typeClassGroups.get(typeClassName)!.push(entry);
    }
  };

  if (models.size > 0) {
    for (const [modelId, model] of models) {
      if (model.ifcDataStore) {
        processDataStore(model.ifcDataStore, modelId);
      }
    }
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, 'legacy');
  }

  const nodes: TreeNode[] = [];

  // Sort type class groups alphabetically
  const sortedClassNames = Array.from(typeClassGroups.keys()).sort();

  for (const className of sortedClassNames) {
    const types = typeClassGroups.get(className)!;
    const classNodeId = `typeclass-${className}`;
    const isClassExpanded = expandedNodes.has(classNodeId);

    // Total instances across all types in this class
    const totalInstances = types.reduce((sum, t) => sum + t.instances.length, 0);
    // Collect all instance globalIds for visibility/isolation
    const allInstanceGlobalIds = types.flatMap(t => t.instances.map(i => i.globalId));

    nodes.push({
      id: classNodeId,
      expressIds: types.flatMap(t => t.instances.map(i => i.expressId)),
      globalIds: allInstanceGlobalIds,
      modelIds: [],
      name: className,
      type: 'type-group',
      ifcType: className,
      depth: 0,
      hasChildren: types.length > 0,
      isExpanded: isClassExpanded,
      isVisible: true,
      elementCount: totalInstances,
    });

    if (isClassExpanded) {
      // Sort types by name
      types.sort((a, b) => a.typeName.localeCompare(b.typeName));

      for (const typeEntry of types) {
        const typeNodeId = `ifctype-${typeEntry.modelId}-${typeEntry.typeExpressId}`;
        const isTypeExpanded = expandedNodes.has(typeNodeId);
        const instanceGlobalIds = typeEntry.instances.map(i => i.globalId);
        const suffix = isMultiModel ? ` [${models.get(typeEntry.modelId)?.name || typeEntry.modelId}]` : '';

        nodes.push({
          id: typeNodeId,
          expressIds: typeEntry.instances.map(i => i.expressId),
          globalIds: instanceGlobalIds,
          entityExpressId: typeEntry.typeExpressId,
          modelIds: [typeEntry.modelId],
          name: `${typeEntry.typeName}${suffix}`,
          type: 'ifc-type',
          ifcType: typeEntry.typeClassName,
          depth: 1,
          hasChildren: typeEntry.instances.length > 0,
          isExpanded: isTypeExpanded,
          isVisible: true,
          elementCount: typeEntry.instances.length,
        });

        if (isTypeExpanded) {
          typeEntry.instances.sort((a, b) => a.name.localeCompare(b.name));
          for (const inst of typeEntry.instances) {
            const instSuffix = isMultiModel ? ` [${models.get(inst.modelId)?.name || inst.modelId}]` : '';
            nodes.push({
              id: `element-${inst.modelId}-${inst.expressId}`,
              expressIds: [inst.expressId],
              globalIds: [inst.globalId],
              modelIds: [inst.modelId],
              name: inst.name + instSuffix,
              type: 'element',
              ifcType: inst.ifcType,
              depth: 2,
              hasChildren: false,
              isExpanded: false,
              isVisible: true,
            });
          }
        }
      }
    }
  }

  return nodes;
}

/**
 * Build a flat "By Material" tree: one row per base material (IfcMaterial),
 * grouped by name so the same-named material across federated models merges.
 * Each row carries the using elements' global ids for click-to-isolate and the
 * representative material express id for the properties panel. Mirrors
 * {@link buildIfcTypeTree} but keyed on the parser's material usage index.
 */
export function buildMaterialTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  _expandedNodes: Set<string>,
  _isMultiModel: boolean,
  geometricIds?: Set<number>,
): TreeNode[] {
  interface MatEntry {
    name: string;
    ifcClass: string;
    materialId: number;          // representative material express id
    modelIds: Set<string>;       // contributing models (insertion order)
    elements: Map<number, number>; // globalId -> expressId (deduped)
  }

  const byName = new Map<string, MatEntry>();
  const applyGeomFilter = !!geometricIds && geometricIds.size > 0;

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    const usage = buildMaterialUsageIndex(dataStore);
    for (const u of usage.values()) {
      let entry = byName.get(u.name);
      if (!entry) {
        // Invariant: the representative `materialId` and the first entry in
        // `modelIds` come from the SAME (first-contributing) model, so the click
        // handler's `node.modelIds[0]` + `node.entityExpressId` always resolve a
        // valid (model, material) pair. Sets preserve insertion order.
        entry = {
          name: u.name,
          ifcClass: u.ifcClass,
          materialId: u.id,
          modelIds: new Set([modelId]),
          elements: new Map(),
        };
        byName.set(u.name, entry);
      } else {
        entry.modelIds.add(modelId);
      }
      for (const { entityId } of u.entries) {
        const globalId = resolveTreeGlobalId(modelId, entityId, models);
        if (applyGeomFilter && !geometricIds!.has(globalId)) continue;
        entry.elements.set(globalId, entityId);
      }
    }
  };

  if (models.size > 0) {
    for (const [modelId, model] of models) {
      if (model.ifcDataStore) processDataStore(model.ifcDataStore, modelId);
    }
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, 'legacy');
  }

  const nodes: TreeNode[] = [];
  const names = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const entry = byName.get(name)!;
    if (entry.elements.size === 0) continue; // skip materials with no visible elements (dead clicks)
    nodes.push({
      id: `material-${name}`,
      expressIds: Array.from(entry.elements.values()),
      globalIds: Array.from(entry.elements.keys()),
      entityExpressId: entry.materialId,
      modelIds: Array.from(entry.modelIds),
      name,
      type: 'material-group',
      ifcType: entry.ifcClass,
      depth: 0,
      hasChildren: false,
      isExpanded: false,
      isVisible: true,
      elementCount: entry.elements.size,
    });
  }

  return nodes;
}

/**
 * Concrete IfcGroup subtypes the Groups tab enumerates EXPLICITLY. The entity
 * index (`entityIndex.byType` / `getEntitiesByType`) is exact-match with no
 * subtype closure, so querying 'IfcSystem' alone would silently miss
 * IfcDistributionSystem / IfcBuiltSystem — exactly the classes MEP files use
 * (issue #1622; same defect class as #1662). This must list EVERY concrete
 * IfcGroup descendant in the supported schemas (IFC4 / IFC4X3) or those classes
 * never appear in the tab. Order = display order: systems, then zones, then
 * generic groups.
 */
export const GROUP_ENTITY_TYPES = [
  // IfcSystem family (bucketed under Systems).
  'IfcDistributionSystem',
  'IfcDistributionCircuit',
  'IfcBuiltSystem',
  'IfcBuildingSystem',
  'IfcStructuralAnalysisModel',
  'IfcSystem',
  // IfcZone (its own bucket, though schema-wise a subtype of IfcSystem).
  'IfcZone',
  // Remaining concrete IfcGroup descendants (bucketed under Other).
  'IfcAsset',
  'IfcInventory',
  'IfcStructuralLoadGroup',
  'IfcStructuralLoadCase',
  'IfcStructuralResultGroup',
  'IfcGroup',
] as const;

/** Sub-filter chips for the Groups tab (#1622). */
export type GroupSubFilter = 'all' | 'systems' | 'zones' | 'other';

const SYSTEM_GROUP_TYPES: ReadonlySet<string> = new Set([
  'IfcDistributionSystem',
  'IfcDistributionCircuit',
  'IfcBuiltSystem',
  'IfcBuildingSystem',
  'IfcStructuralAnalysisModel',
  'IfcSystem',
]);

/** Whether a group entity class passes the Groups-tab sub-filter.
 *  Systems = the IfcSystem family (incl. IfcDistributionCircuit and
 *  IfcStructuralAnalysisModel); Zones = IfcZone; Other = IfcGroup, IfcAsset,
 *  IfcInventory, the structural load/result groups and any remaining class. */
export function groupMatchesSubFilter(ifcType: string, filter: GroupSubFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'systems': return SYSTEM_GROUP_TYPES.has(ifcType);
    case 'zones': return ifcType === 'IfcZone';
    case 'other': return !SYSTEM_GROUP_TYPES.has(ifcType) && ifcType !== 'IfcZone';
  }
}

/** A geometry-bearing entity a group member resolves to. */
export interface ResolvedMemberGeometry {
  expressId: number;
  globalId: number;
}

/**
 * Resolve a group member to the geometry that should represent it (#1622).
 * IfcRelAssignsToGroup members are frequently geometry-less: in HVAC exports
 * roughly two thirds of an IfcDistributionSystem's members are
 * IfcDistributionPorts, so raw isolation would render a perforated (or empty)
 * network. If the member itself carries geometry, that's the answer; otherwise
 * fold in its IfcRelNests/IfcRelAggregates relatives — IfcRelNests is mapped
 * onto the shared Aggregates edge bucket (see columnar-parser-indexes), so
 * `inverse` yields a port's nesting host element and `forward` yields nested /
 * aggregated children — keeping only relatives that actually have geometry.
 * Returns [] when nothing resolves (e.g. a nested IfcZone member).
 */
export function resolveMemberGeometry(
  dataStore: IfcDataStore,
  memberExpressId: number,
  toGlobal: (expressId: number) => number,
  geometricIds: Set<number>,
): ResolvedMemberGeometry[] {
  const ownGlobal = toGlobal(memberExpressId);
  if (geometricIds.has(ownGlobal)) {
    return [{ expressId: memberExpressId, globalId: ownGlobal }];
  }
  const relationships = dataStore.relationships;
  if (!relationships) return [];
  const out: ResolvedMemberGeometry[] = [];
  const seen = new Set<number>();
  for (const direction of ['inverse', 'forward'] as const) {
    for (const relatedId of relationships.getRelated(memberExpressId, RelationshipType.Aggregates, direction)) {
      if (relatedId === memberExpressId || seen.has(relatedId)) continue;
      seen.add(relatedId);
      const globalId = toGlobal(relatedId);
      if (geometricIds.has(globalId)) {
        out.push({ expressId: relatedId, globalId });
      }
    }
  }
  return out;
}

/**
 * Build the flat "Groups" tree (#1622): one 'group' row per IfcGroup-family
 * entity (enumerated via {@link GROUP_ENTITY_TYPES}), expanding to
 * 'group-member' child rows. Mirrors {@link buildMaterialTree} structurally.
 *
 * Group membership is MANY-TO-MANY (an element may sit in several systems, a
 * space in several zones) — the same entity legitimately appears under multiple
 * group rows, distinguished by the composite node id. Members are deduped only
 * WITHIN one group (a host element and its two ports must not yield three rows).
 *
 * Member rows: a geometry-bearing member appears as itself; a geometry-less
 * member (IfcDistributionPort) is represented by the geometry-bearing relatives
 * it resolves to via {@link resolveMemberGeometry}; a member with no resolvable
 * geometry at all (e.g. a nested IfcZone) keeps a select-only row. The group
 * row's `globalIds` carry the union of resolved geometry for O(1)
 * isolate / eye-toggle / basket.
 */
export function buildGroupTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: Set<string>,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
  subFilter: GroupSubFilter = 'all',
): TreeNode[] {
  interface MemberRow {
    expressId: number;
    globalId: number;
    name: string;
    ifcType: string;
  }
  interface GroupEntry {
    modelId: string;
    groupExpressId: number;
    name: string;
    ifcType: string;
    typeRank: number;
    memberRows: MemberRow[];
    isolationGlobalIds: number[];
  }

  const geo = geometricIds ?? new Set<number>();
  const entries: GroupEntry[] = [];

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    const byType = dataStore.entityIndex?.byType;
    const entities = dataStore.entities;
    if (!byType || !entities) return;
    const toGlobal = (expressId: number) => resolveTreeGlobalId(modelId, expressId, models);

    for (let rank = 0; rank < GROUP_ENTITY_TYPES.length; rank++) {
      const typeName = GROUP_ENTITY_TYPES[rank];
      if (!groupMatchesSubFilter(typeName, subFilter)) continue;
      const groupIds = byType.get(typeName.toUpperCase());
      if (!groupIds || groupIds.length === 0) continue;

      for (const groupId of groupIds) {
        const members = extractGroupMembersOnDemand(dataStore, groupId);
        // Empty group: a dead click, skip (mirror the empty-material skip).
        if (members.length === 0) continue;

        const rowByGlobalId = new Map<number, MemberRow>();
        const isolation = new Set<number>();
        for (const member of members) {
          const ownGlobal = toGlobal(member.id);
          const resolved = resolveMemberGeometry(dataStore, member.id, toGlobal, geo);
          for (const r of resolved) isolation.add(r.globalId);

          if (resolved.length === 1 && resolved[0].expressId === member.id) {
            // Member carries its own geometry — list it as itself.
            if (!rowByGlobalId.has(ownGlobal)) {
              rowByGlobalId.set(ownGlobal, {
                expressId: member.id,
                globalId: ownGlobal,
                name: member.name || `${member.type} #${member.id}`,
                ifcType: member.type,
              });
            }
          } else if (resolved.length > 0) {
            // Geometry-less member (port): list its geometry-bearing relatives
            // instead of a dead row. The host element is often ALSO a direct
            // member — the by-globalId map collapses those to one row.
            for (const r of resolved) {
              if (rowByGlobalId.has(r.globalId)) continue;
              const relName = entities.getName(r.expressId);
              const relType = entities.getTypeName(r.expressId) || 'Unknown';
              rowByGlobalId.set(r.globalId, {
                expressId: r.expressId,
                globalId: r.globalId,
                name: relName || `${relType} #${r.expressId}`,
                ifcType: relType,
              });
            }
          } else if (!rowByGlobalId.has(ownGlobal)) {
            // No geometry anywhere (nested group/zone, proxy without shape):
            // keep a select-only row so the membership stays browsable.
            rowByGlobalId.set(ownGlobal, {
              expressId: member.id,
              globalId: ownGlobal,
              name: member.name || `${member.type} #${member.id}`,
              ifcType: member.type,
            });
          }
        }

        // Name with ObjectType fallback for unnamed systems — same display
        // logic as the properties panel's Groups & Zones card (#1075).
        const name = entities.getName(groupId);
        const objectType = entities.getObjectType?.(groupId);
        entries.push({
          modelId,
          groupExpressId: groupId,
          name: name || objectType || `${typeName} #${groupId}`,
          ifcType: typeName,
          typeRank: rank,
          memberRows: Array.from(rowByGlobalId.values()),
          isolationGlobalIds: Array.from(isolation),
        });
      }
    }
  };

  if (models.size > 0) {
    for (const [modelId, model] of models) {
      if (model.ifcDataStore) processDataStore(model.ifcDataStore, modelId);
    }
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, 'legacy');
  }

  // Systems first, then zones, then generic groups; name order within a class.
  entries.sort((a, b) => a.typeRank - b.typeRank || storeyNameCollator.compare(a.name, b.name));

  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const nodeId = `group-${entry.modelId}-${entry.groupExpressId}`;
    const hasChildren = entry.memberRows.length > 0;
    const isExpanded = hasChildren && expandedNodes.has(nodeId);
    const suffix = isMultiModel ? ` [${models.get(entry.modelId)?.name || entry.modelId}]` : '';

    nodes.push({
      id: nodeId,
      expressIds: [entry.groupExpressId],
      globalIds: entry.isolationGlobalIds,
      entityExpressId: entry.groupExpressId,
      modelIds: [entry.modelId],
      name: entry.name + suffix,
      type: 'group',
      ifcType: entry.ifcType,
      depth: 0,
      hasChildren,
      isExpanded,
      isVisible: true,
      elementCount: entry.memberRows.length,
    });

    if (isExpanded) {
      const rows = [...entry.memberRows].sort((a, b) => storeyNameCollator.compare(a.name, b.name));
      for (const row of rows) {
        nodes.push({
          // Composite id keyed by the OWNING group: the same member under N
          // groups yields N distinct rows — spec-correct many-to-many (#1622).
          id: `groupmember-${entry.modelId}-${entry.groupExpressId}-${row.expressId}`,
          expressIds: [row.expressId],
          globalIds: [row.globalId],
          modelIds: [entry.modelId],
          name: row.name,
          type: 'group-member',
          ifcType: row.ifcType,
          depth: 1,
          hasChildren: false,
          isExpanded: false,
          isVisible: true,
        });
      }
    }
  }

  return nodes;
}

/** Filter nodes based on search query */
export function filterNodes(nodes: TreeNode[], searchQuery: string): TreeNode[] {
  if (!searchQuery.trim()) return nodes;
  const query = searchQuery.toLowerCase();
  return nodes.filter(node =>
    node.name.toLowerCase().includes(query) ||
    (node.secondaryName?.toLowerCase().includes(query) ?? false) ||
    node.type.toLowerCase().includes(query)
  );
}

/** Split filtered nodes into storeys and models sections (for multi-model mode) */
export function splitNodes(
  filteredNodes: TreeNode[],
  isMultiModel: boolean
): { storeysNodes: TreeNode[]; modelsNodes: TreeNode[] } {
  if (!isMultiModel) {
    // Single model mode - all nodes go in storeys section (which is the full hierarchy)
    return { storeysNodes: filteredNodes, modelsNodes: [] };
  }

  // Find the models-header index to split
  const modelsHeaderIdx = filteredNodes.findIndex(n => n.id === 'models-header');
  if (modelsHeaderIdx === -1) {
    return { storeysNodes: filteredNodes, modelsNodes: [] };
  }

  return {
    storeysNodes: filteredNodes.slice(0, modelsHeaderIdx),
    modelsNodes: filteredNodes.slice(modelsHeaderIdx + 1), // Skip the models-header itself
  };
}
