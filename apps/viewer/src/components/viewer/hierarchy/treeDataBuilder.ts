/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveTreeType, type TreeOverlay } from './treeOverlay.js';
import { effectiveTreeEntityName, effectiveTypeAssignments, effectiveTypeEntities, effectiveTypeInstanceIds } from './effectiveTypeEntities.js';
import { effectiveGroupAssignments, effectiveGroupIds, effectiveGroupMembers, effectiveGroupName } from './effectiveGroupEntities.js';
import { GROUP_ENTITY_TYPES, groupMatchesSubFilter } from './groupEntityTypes.js';
import type { GroupSubFilter } from './groupEntityTypes.js';
// Re-exported so the Groups tab's callers and tests keep importing these
// from here; the tables themselves live in ./groupEntityTypes.ts.
export { GROUP_ENTITY_TYPES, groupMatchesSubFilter } from './groupEntityTypes.js';
export type { GroupSubFilter } from './groupEntityTypes.js';

import {
  IfcTypeEnum,
  RelationshipType,
  isSpaceLikeSpatialType,
  isStoreyLikeSpatialType,
  type SpatialNode,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { buildMaterialUsageIndex } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { mergeObjectCounts, summarizeObjects } from './objectCountSummary';
import { buildOtherGroupNodes, type OtherBucketEntry } from './otherBucket';
import { emitElementsWithOtherBucket } from './elementSubtree';
import {
  makeAssemblyGeometry,
  partsOrOwnIds,
  resolveTreeGlobalId,
} from './productTree';
import type { TreeNode, NodeType, StoreyData, UnifiedStorey, HierarchySortMode, ExpansionLookup } from './types';
import { DEFAULT_HIERARCHY_SORT } from './types';
import { getSpatialNodeElements, indexSpatialNodes } from './spatialElements';
import {
  createStoreyDisplayElevationResolver,
} from '@/lib/geo/storey-elevation';
import type { GeorefMutationDataLike } from '@/lib/geo/effective-georef';

/** Per-model georef edits, keyed like the store's `georefMutations`. */
export type GeorefMutationsByModel = ReadonlyMap<string, GeorefMutationDataLike>;

/** Absolute storey elevation for a badge, given the relative one (#4843). */
type StoreyDisplayElevation = (storeyId: number, relativeElevationMeters: number) => number;

/** The badge value source for one model. Legacy single-store mode keys its
 *  georef edits under `__legacy__`, matching the Inspector. */
function storeyDisplayElevationFor(
  modelId: string,
  dataStore: IfcDataStore,
  model: FederatedModel | undefined,
  georefMutations: GeorefMutationsByModel | undefined,
): StoreyDisplayElevation {
  const mutationKey = modelId === 'legacy' ? '__legacy__' : modelId;
  return createStoreyDisplayElevationResolver(
    dataStore,
    model?.geometryResult?.coordinateInfo,
    georefMutations?.get(mutationKey),
  );
}

/** Two contributors show the same badge when they round to the same centimetre. */
const DISPLAY_ELEVATION_AGREEMENT_M = 0.005;

/** Helper to create elevation key (with 0.5m tolerance for matching) */
export function elevationKey(elevation: number): string {
  return (Math.round(elevation * 2) / 2).toFixed(2);
}

/** "Level" rows the browser sorts: building storeys plus their IFC4.3
 *  facility-part equivalents — every concrete IfcFacilityPart subtype, plus the
 *  abstract base itself for a defensively-typed entity. These
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
    type === IfcTypeEnum.IfcRailwayPart ||
    type === IfcTypeEnum.IfcMarinePart ||
    type === IfcTypeEnum.IfcFacilityPartCommon
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
    case IfcTypeEnum.IfcMarinePart: return 'IfcMarinePart';
    case IfcTypeEnum.IfcFacilityPartCommon: return 'IfcFacilityPartCommon';
    case IfcTypeEnum.IfcSpace: return 'IfcSpace';
    case IfcTypeEnum.IfcSpatialZone: return 'IfcSpatialZone';
    default: return 'element';
  }
}

/**
 * The shape half of the object count: "would this entity put anything on
 * screen?".
 *
 * It is `makeAssemblyGeometry`'s own `renders`, not a second reading of the
 * mesh set, so the spatial badge and the By Class tab cannot answer the same
 * question differently -- an `IfcRoof` whose geometry sits on its
 * `IfcRelAggregates` beams renders in both or neither.
 *
 * `null` while nothing has streamed: the shape test is unanswerable then, so
 * the count reports every physical object and says on hover that it is still
 * provisional, rather than reading an empty mesh set as "nothing has a shape".
 */
function makeShapeTest(
  dataStore: IfcDataStore,
  modelId: string,
  models: Map<string, FederatedModel>,
  geometricIds: Set<number> | undefined,
  geometryKnown = !!geometricIds && geometricIds.size > 0,
): ((id: number) => boolean) | null {
  if (!geometryKnown) return null;
  const assemblyGeometry = makeAssemblyGeometry(dataStore, modelId, models, geometricIds, true);
  return (id: number) =>
    assemblyGeometry.renders(
      dataStore.entities?.getTypeName(id) ?? 'Unknown',
      id,
      resolveTreeGlobalId(modelId, id, models),
    );
}

/** Build unified storey data for multi-model mode */
export function buildUnifiedStoreys(
  models: Map<string, FederatedModel>,
  sortMode: HierarchySortMode = DEFAULT_HIERARCHY_SORT,
  geometricIds?: Set<number>,
  geometryReadyModelIds?: ReadonlySet<string>,
  georefMutations?: GeorefMutationsByModel,
): UnifiedStorey[] {
  if (models.size <= 1) return [];

  const storeysByElevation = new Map<string, UnifiedStorey>();

  for (const [modelId, model] of models) {
    const dataStore = model.ifcDataStore;
    if (!dataStore?.spatialHierarchy) continue;

    const hierarchy = dataStore.spatialHierarchy;
    const { byStorey, storeyElevations } = hierarchy;
    // Partial/native metadata stores can expose the lookup maps before (or
    // without) a project tree. Keep their previous byStorey-only behaviour.
    const spatialNodes = hierarchy.project
      ? indexSpatialNodes(hierarchy.project)
      : new Map<number, SpatialNode>();
    const descendantSpaceCache = new Map<number, Set<number>>();
    const displayElevationOf = storeyDisplayElevationFor(modelId, dataStore, model, georefMutations);

    for (const [storeyId, elements] of byStorey.entries()) {
      const elevation = storeyElevations.get(storeyId) ?? 0;
      const name = dataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
      const key = elevationKey(elevation);
      const storeyNode = spatialNodes.get(storeyId);
      const directElements = storeyNode
        ? getSpatialNodeElements(
            storeyNode,
            dataStore,
            'IfcBuildingStorey',
            descendantSpaceCache,
          )
        : elements as number[];
      const spacesNotCounted = storeyNode
        ? (storeyNode.children ?? []).filter((child) => isSpaceLikeSpatialType(child.type)).length
        : 0;

      const storeyData: StoreyData = {
        modelId,
        storeyId,
        name,
        elevation,
        displayElevation: displayElevationOf(storeyId, elevation),
        elements: directElements,
        objects: summarizeObjects(
          directElements,
          (id) => dataStore.entities?.getTypeName(id),
          makeShapeTest(
            dataStore,
            modelId,
            models,
            geometricIds,
            geometryReadyModelIds?.has(modelId),
          ),
          spacesNotCounted,
        ),
      };

      if (storeysByElevation.has(key)) {
        const unified = storeysByElevation.get(key)!;
        unified.storeys.push(storeyData);
        unified.totalElements += directElements.length;
        unified.objects = mergeObjectCounts(unified.objects, storeyData.objects);
        if (name.length < unified.name.length) {
          unified.name = name;
        }
        if (
          unified.displayElevation !== undefined
          && Math.abs(unified.displayElevation - storeyData.displayElevation) > DISPLAY_ELEVATION_AGREEMENT_M
        ) {
          unified.displayElevation = undefined;
        }
      } else {
        storeysByElevation.set(key, {
          key,
          name,
          elevation,
          displayElevation: storeyData.displayElevation,
          storeys: [storeyData],
          totalElements: directElements.length,
          objects: storeyData.objects,
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
  expandedNodes: ExpansionLookup,
  nodes: TreeNode[],
  descendantSpaceCache: Map<number, Set<number>>,
  sortMode: HierarchySortMode,
  hasShape: ((id: number) => boolean) | null = null,
  displayElevationOf: StoreyDisplayElevation | null = null,
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
  // The badge answers "how many objects are on this storey"; the rows below
  // still list everything it contains, so an annotation or a shapeless element
  // stays selectable without being counted as an object. A space is a spatial
  // element, so neither it nor its contents roll up here — the count is what
  // the container directly holds.
  const spaceChildren = (spatialNode.children ?? []).filter((c) => isSpaceLikeSpatialType(c.type));
  const objects = summarizeObjects(
    elements,
    (id) => dataStore.entities?.getTypeName(id),
    hasShape,
    spaceChildren.length,
  );

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
    modelId,
    name: primaryName,
    secondaryName,
    type: nodeType,
    depth,
    hasChildren,
    isExpanded: isNodeExpanded,
    isVisible: true, // Visibility computed lazily during render
    elementCount: hasDirectElements ? objects.counted : undefined,
    countSummary: hasDirectElements ? objects : undefined,
    storeyDisplayElevation: spatialNode.elevation === undefined
      ? undefined
      : (displayElevationOf?.(spatialNode.expressId, spatialNode.elevation) ?? spatialNode.elevation),
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
        sortMode,
        hasShape,
        displayElevationOf,
      );
    }

    // Add direct spatial children elements for expanded nodes — each may itself
    // decompose into nested parts via IfcRelAggregates (issue #1133). Order them
    // by the active name sort so it reaches inside the storey/space, not just the
    // storey rows (issue #1476).
    if (hasDirectElements) {
      emitElementsWithOtherBucket(
        elements,
        modelId,
        models,
        dataStore,
        depth + 1,
        expandedNodes,
        nodes,
        sortMode,
        hasShape,
        `${nodeId}-other`,
      );
    }
  }
}

/** Build the complete tree data structure */
export function buildTreeData(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: ExpansionLookup,
  isMultiModel: boolean,
  unifiedStoreys: UnifiedStorey[],
  sortMode: HierarchySortMode = DEFAULT_HIERARCHY_SORT,
  geometricIds?: Set<number>,
  geometryReadyModelIds?: ReadonlySet<string>,
  georefMutations?: GeorefMutationsByModel,
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
        elementCount: unified.objects.counted,
        countSummary: unified.objects,
        storeyDisplayElevation: unified.displayElevation,
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
            modelId: storey.modelId,
            name: modelName,
            type: 'model-header',
            depth: 1,
            hasChildren: storey.elements.length > 0,
            isExpanded: contribExpanded,
            isVisible: true, // Computed lazily during render
            elementCount: storey.objects.counted,
            countSummary: storey.objects,
            // Federated models can sit at different absolute heights even when
            // their relative elevations group them together; label each one.
            storeyDisplayElevation: unified.displayElevation === undefined
              ? storey.displayElevation
              : undefined,
            _idOffset: offset,
          });

          // If contribution expanded, show elements (assemblies nest their
          // IfcRelAggregates parts — issue #1133), ordered by the active name
          // sort so it reaches inside the storey (issue #1476).
          if (contribExpanded && model?.ifcDataStore) {
            emitElementsWithOtherBucket(
              storey.elements,
              storey.modelId,
              models,
              model.ifcDataStore,
              2,
              expandedNodes,
              nodes,
              sortMode,
              makeShapeTest(
                model.ifcDataStore,
                storey.modelId,
                models,
                geometricIds,
                geometryReadyModelIds?.has(storey.modelId),
              ),
              `${contribNodeId}-other`,
            );
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
        modelId,
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
          sortMode,
          makeShapeTest(
            model.ifcDataStore,
            modelId,
            models,
            geometricIds,
            geometryReadyModelIds?.has(modelId),
          ),
          storeyDisplayElevationFor(modelId, model.ifcDataStore, model, georefMutations),
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
        sortMode,
        makeShapeTest(
          model.ifcDataStore,
          modelId,
          models,
          geometricIds,
          geometryReadyModelIds?.has(modelId),
        ),
        storeyDisplayElevationFor(modelId, model.ifcDataStore, model, georefMutations),
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
      sortMode,
      makeShapeTest(
        ifcDataStore,
        'legacy',
        models,
        geometricIds,
        geometryReadyModelIds?.has('legacy'),
      ),
      storeyDisplayElevationFor('legacy', ifcDataStore, undefined, georefMutations),
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
 *  Only includes entities that have geometry (visible in the 3D viewer), or
 *  that decompose into parts which do — see {@link makeAssemblyGeometry}.
 *  @param geometricIds Pre-computed set of global IDs with geometry (memoized by caller).
 *  @param authoredProducts Overlay-authored products (e.g. a baked IfcSpace) that
 *    aren't in the columnar table but have geometry — folded into their class. */
export function buildTypeTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: ExpansionLookup,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
  authoredProducts?: AuthoredProduct[],
  geometryReadyModelIds?: ReadonlySet<string>,
  overlay?: TreeOverlay,
): TreeNode[] {
  // Collect entities grouped by IFC class across all models
  const typeGroups = new Map<string, Array<{ expressId: number; globalId: number; name: string; modelId: string; parts?: number[] }>>();
  // Physical elements with no shape (own or aggregated) — grayed out and
  // bucketed under one flat "Other" node rather than dropped or mixed into a
  // class group (#4764). Empty while geometry hasn't loaded for a model yet
  // — `isOther` returns `false` for everything during that window.
  const otherEntities: OtherBucketEntry[] = [];

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    const assemblyGeometry = makeAssemblyGeometry(
      dataStore,
      modelId,
      models,
      geometricIds,
      geometryReadyModelIds?.has(modelId),
    );
    const view = overlay?.(modelId);
    // @raw-entity-enumeration-ok parsed rows, each passed through effectiveTreeType (deleted skipped, retype applied); created products arrive as authoredProducts
    for (let i = 0; i < dataStore.entities.count; i++) {
      const expressId = dataStore.entities.expressId[i];
      const globalId = resolveTreeGlobalId(modelId, expressId, models);

      // Only include entities whose class belongs in a products tree and that
      // render — themselves, or through their IfcRelAggregates parts (a
      // geometry-less assembly).
      const typeName = effectiveTreeType(view, expressId, dataStore.entities.getTypeName(expressId) || 'Unknown');
      if (typeName === null) continue;
      const entityName = dataStore.entities.getName(expressId) || `${typeName} #${expressId}`;
      if (!assemblyGeometry.renders(typeName, expressId, globalId)) {
        if (assemblyGeometry.isOther(typeName, expressId, globalId)) {
          otherEntities.push({ expressId, globalId, name: entityName, modelId, ifcType: typeName });
        }
        continue;
      }

      if (!typeGroups.has(typeName)) {
        typeGroups.set(typeName, []);
      }
      typeGroups.get(typeName)!.push({
        expressId,
        globalId,
        name: entityName,
        modelId,
        parts: assemblyGeometry.parts(expressId, typeName),
      });
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
    // avoiding a full entity scan when the group is collapsed. A geometry-less
    // assembly contributes its geometry-bearing parts instead of its own dead
    // id, so isolating the class actually shows the assemblies in it. NOT
    // index-aligned with `expressIds` (a part-substituted, deduped list can be
    // a different length) — `memberGlobalIds` below is the aligned one.
    const groupGlobalIds = partsOrOwnIds(entities);

    nodes.push({
      id: groupNodeId,
      expressIds: entities.map((e) => e.expressId),
      globalIds: groupGlobalIds,
      // Index-aligned with `expressIds`: each entity's OWN globalId, never a
      // substituted part. Lets a click resolve "the first member of this
      // class" (e.g. to open it in the Properties panel) to the class's own
      // entity rather than an arbitrary part of a decomposed one.
      memberGlobalIds: entities.map((e) => e.globalId),
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
        nodes.push({
          id: `element-${entity.modelId}-${entity.expressId}`,
          expressIds: [entity.expressId],
          globalIds: [entity.globalId],
          modelIds: [entity.modelId],
          modelId: entity.modelId,
          name: entity.name,
          type: 'element',
          ifcType: typeName,
          depth: 1,
          hasChildren: false,
          isExpanded: false,
          isVisible: true,
          assemblyChildGlobalIds: entity.parts,
        });
      }
    }
  }

  // "Other" bucket — geometry-less physical elements, grayed out, after every
  // real class group rather than sorted alphabetically among them (#4764).
  nodes.push(...buildOtherGroupNodes(otherEntities, 'type-group-other', expandedNodes));

  return nodes;
}

/** Build tree data grouped by IFC type entities (IfcWallType, IfcDoorType, etc.).
 *  Shows each type entity as a parent node with its typed instances (occurrences) as children.
 *  Uses IfcRelDefinesByType relationships to find type→occurrence mappings.
 *  Entities without a type are grouped under an "Untyped" section per IFC class. */
export function buildIfcTypeTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: ExpansionLookup,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
  geometryReadyModelIds?: ReadonlySet<string>,
  overlay?: TreeOverlay,
): TreeNode[] {
  // Collect type entities and their typed instances
  interface TypeEntry {
    typeExpressId: number;
    typeName: string;      // e.g. "W01"
    typeClassName: string;  // e.g. "IfcWallType"
    modelId: string;
    globalId: number;
    instances: Array<{ expressId: number; globalId: number; name: string; modelId: string; ifcType: string; parts?: number[] }>;
  }

  // Group by type class name (e.g. "IfcWallType") → individual types
  const typeClassGroups = new Map<string, TypeEntry[]>();
  // Typed occurrences with no shape (own or aggregated) — grayed out, bucketed
  // under one flat "Other" node instead of dropped (#4764). Same rule as
  // `buildTypeTree`'s bucket, applied to occurrences instead of top-level
  // entities.
  const otherInstances: OtherBucketEntry[] = [];

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    if (!dataStore.relationships) return;
    const assemblyGeometry = makeAssemblyGeometry(
      dataStore,
      modelId,
      models,
      geometricIds,
      geometryReadyModelIds?.has(modelId),
    );

    const view = overlay?.(modelId);
    const assignments = effectiveTypeAssignments(dataStore, view);
    for (const { expressId, typeClassName, name: typeName } of effectiveTypeEntities(dataStore, view)) {

      // Get instances via DefinesByType (forward: type → occurrences)
      const instanceIds = effectiveTypeInstanceIds(dataStore, expressId, view, assignments);
      const instances: TypeEntry['instances'] = [];

      for (const instId of instanceIds) {
        const instGlobalId = resolveTreeGlobalId(modelId, instId, models);
        // An IfcElementAssemblyType's occurrences carry no geometry of their
        // own — without this the type row reported 0 elements (#1133).
        const instIfcType = effectiveTreeType(view, instId,
          (view?.getNewEntity(instId)?.type ?? dataStore.entities.getTypeName(instId)) || 'Unknown');
        if (instIfcType === null) continue;
        const instName = effectiveTreeEntityName(dataStore, view, instId);
        if (!assemblyGeometry.renders(instIfcType, instId, instGlobalId)) {
          if (assemblyGeometry.isOther(instIfcType, instId, instGlobalId)) {
            otherInstances.push({ expressId: instId, globalId: instGlobalId, name: instName, modelId, ifcType: instIfcType });
          }
          continue;
        }
        instances.push({
          expressId: instId,
          globalId: instGlobalId,
          name: instName,
          modelId,
          ifcType: instIfcType,
          parts: assemblyGeometry.parts(instId, instIfcType),
        });
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

    const allInstances = types.flatMap(t => t.instances);
    // Total instances across all types in this class
    const totalInstances = allInstances.length;
    // Collect all instance globalIds for visibility/isolation — a geometry-
    // less assembly occurrence stands in for its geometry-bearing parts (see
    // `partsOrOwnIds`), so NOT index-aligned with `expressIds` below.
    const allInstanceGlobalIds = partsOrOwnIds(allInstances);

    nodes.push({
      id: classNodeId,
      expressIds: types.flatMap(t => t.instances.map(i => i.expressId)),
      globalIds: allInstanceGlobalIds,
      // Index-aligned with `expressIds`: each occurrence's OWN globalId.
      memberGlobalIds: allInstances.map((i) => i.globalId),
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
        const instanceGlobalIds = partsOrOwnIds(typeEntry.instances);
        nodes.push({
          id: typeNodeId,
          expressIds: typeEntry.instances.map(i => i.expressId),
          globalIds: instanceGlobalIds,
          memberGlobalIds: typeEntry.instances.map((i) => i.globalId),
          entityExpressId: typeEntry.typeExpressId,
          modelIds: [typeEntry.modelId],
          modelId: typeEntry.modelId,
          name: typeEntry.typeName,
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
            nodes.push({
              id: `element-${inst.modelId}-${inst.expressId}`,
              expressIds: [inst.expressId],
              globalIds: [inst.globalId],
              modelIds: [inst.modelId],
              modelId: inst.modelId,
              name: inst.name,
              type: 'element',
              ifcType: inst.ifcType,
              depth: 2,
              hasChildren: false,
              isExpanded: false,
              isVisible: true,
              assemblyChildGlobalIds: inst.parts,
            });
          }
        }
      }
    }
  }

  // "Other" bucket — geometry-less typed occurrences, grayed out, listed
  // after every real class group (#4764). Flat, not re-nested under their
  // original type, since the point of this row is that it fell out of the
  // class it belongs to.
  nodes.push(...buildOtherGroupNodes(otherInstances, 'typeclass-other', expandedNodes));

  return nodes;
}

/**
 * Build a flat "By Material" tree: one row per base material (IfcMaterial),
 * grouped by name within each independent data store so equal names in a
 * federation keep their source model and representative material entity.
 * IFCX layers sharing one composed store yield one row without a false
 * per-layer badge (#5888).
 * Each row carries the using elements' global ids for click-to-isolate and the
 * representative material express id for the properties panel. Mirrors
 * {@link buildIfcTypeTree} but keyed on the parser's material usage index.
 */
export function buildMaterialTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  _expandedNodes: ExpansionLookup,
  _isMultiModel: boolean,
  geometricIds?: Set<number>,
  geometryReadyModelIds?: ReadonlySet<string>,
): TreeNode[] {
  interface MatEntry {
    name: string;
    modelIds: string[];
    ifcClass: string;
    materialId: number;          // representative material express id
    elements: Map<number, number>; // globalId -> expressId (deduped)
  }

  const byName = new Map<string, MatEntry>();
  const processDataStore = (dataStore: IfcDataStore, ownerModelIds: string[]) => {
    const modelId = ownerModelIds[0];
    const applyGeomFilter = geometryReadyModelIds
      ? ownerModelIds.some((owner) => geometryReadyModelIds.has(owner))
      : !!geometricIds && geometricIds.size > 0;
    const usage = buildMaterialUsageIndex(dataStore);
    for (const u of usage.values()) {
      const key = JSON.stringify([modelId, u.name]);
      let entry = byName.get(key);
      if (!entry) {
        entry = {
          name: u.name,
          modelIds: ownerModelIds,
          ifcClass: u.ifcClass,
          materialId: u.id,
          elements: new Map(),
        };
        byName.set(key, entry);
      }
      for (const { entityId } of u.entries) {
        const globalId = resolveTreeGlobalId(modelId, entityId, models);
        if (applyGeomFilter && !geometricIds!.has(globalId)) continue;
        entry.elements.set(globalId, entityId);
      }
    }
  };

  if (models.size > 0) {
    // IFCX layers can share one composed store. Its material usage has no
    // per-layer provenance, so emit one unattributed row for that store.
    const storeOwners = new Map<IfcDataStore, string[]>();
    for (const [modelId, model] of models) {
      if (!model.ifcDataStore) continue;
      const owners = storeOwners.get(model.ifcDataStore) ?? [];
      owners.push(modelId);
      storeOwners.set(model.ifcDataStore, owners);
    }
    for (const [store, owners] of storeOwners) processDataStore(store, owners);
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, ['legacy']);
  }

  const nodes: TreeNode[] = [];
  const entries = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name) || a.modelIds[0].localeCompare(b.modelIds[0]));
  for (const entry of entries) {
    if (entry.elements.size === 0) continue; // skip materials with no visible elements (dead clicks)
    nodes.push({
      id: `material-${entry.modelIds[0]}-${entry.materialId}`,
      expressIds: Array.from(entry.elements.values()),
      globalIds: Array.from(entry.elements.keys()),
      entityExpressId: entry.materialId,
      modelIds: entry.modelIds,
      modelId: entry.modelIds.length === 1 ? entry.modelIds[0] : undefined,
      name: entry.name,
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
  expandedNodes: ExpansionLookup,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
  subFilter: GroupSubFilter = 'all',
  overlay?: TreeOverlay,
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
    const entities = dataStore.entities;
    if (!entities) return;
    const toGlobal = (expressId: number) => resolveTreeGlobalId(modelId, expressId, models);
    const view = overlay?.(modelId);
    const groups = effectiveGroupIds(dataStore, view);
    const assignments = effectiveGroupAssignments(dataStore, view);

    for (let rank = 0; rank < GROUP_ENTITY_TYPES.length; rank++) {
      const typeName = GROUP_ENTITY_TYPES[rank];
      if (!groupMatchesSubFilter(typeName, subFilter)) continue;
      const groupIds = groups.get(typeName);
      if (!groupIds || groupIds.length === 0) continue;

      for (const groupId of groupIds) {
        const members = effectiveGroupMembers(dataStore, groupId, view, assignments);
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
        entries.push({
          modelId,
          groupExpressId: groupId,
          name: effectiveGroupName(dataStore, view, groupId, typeName),
          ifcType: typeName,
          typeRank: rank,
          memberRows: Array.from(rowByGlobalId.values()),
          isolationGlobalIds: Array.from(isolation),
        });
      }
    }
  };

  if (models.size > 0) {
    // Federated IFCX layers all share ONE composed data store (each overlay
    // is registered as a "model" for the Models panel) — process each
    // distinct store once or every group row would repeat per layer.
    const processed = new Set<IfcDataStore>();
    for (const [modelId, model] of models) {
      const store = model.ifcDataStore;
      if (!store || processed.has(store)) continue;
      processed.add(store);
      processDataStore(store, modelId);
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
    nodes.push({
      id: nodeId,
      expressIds: [entry.groupExpressId],
      globalIds: entry.isolationGlobalIds,
      entityExpressId: entry.groupExpressId,
      modelIds: [entry.modelId],
      modelId: entry.modelId,
      name: entry.name,
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
          modelId: entry.modelId,
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

/** Keep matches and their ancestors from the fully expanded search projection. */
export function filterNodes(nodes: TreeNode[], searchQuery: string): TreeNode[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return nodes;
  const ancestors: number[] = [];
  const included = new Set<number>();
  let modelsHeader = -1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.id === 'models-header') {
      modelsHeader = index;
      ancestors.length = 0;
      continue;
    }
    ancestors.length = Math.min(ancestors.length, node.depth);
    if (node.name.toLowerCase().includes(query) || node.secondaryName?.toLowerCase().includes(query)) {
      included.add(index);
      for (const ancestor of ancestors) included.add(ancestor);
      if (modelsHeader >= 0) included.add(modelsHeader);
    }
    ancestors[node.depth] = index;
  }
  return nodes.filter((_, index) => included.has(index));
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
