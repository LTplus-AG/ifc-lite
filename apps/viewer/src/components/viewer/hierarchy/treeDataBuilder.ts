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
import { buildMaterialUsageIndex } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { TreeNode, NodeType, StoreyData, UnifiedStorey } from './types';

/** Helper to create elevation key (with 0.5m tolerance for matching) */
export function elevationKey(elevation: number): string {
  return (Math.round(elevation * 2) / 2).toFixed(2);
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
export function buildUnifiedStoreys(models: Map<string, FederatedModel>): UnifiedStorey[] {
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
    .sort((a, b) => b.elevation - a.elevation);
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
  expandedNodes: Set<string>,
  nodes: TreeNode[],
  descendantSpaceCache: Map<number, Set<number>>
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
    name: (spatialNode.name && spatialNode.name.toLowerCase() !== 'unknown')
      ? spatialNode.name
      : nodeType,
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
    // Sort storeys by elevation descending
    const shouldSortByElevation = (spatialNode.children || []).some((child) => isStoreyLikeSpatialType(child.type));
    const sortedChildren = shouldSortByElevation
      ? [...(spatialNode.children || [])].sort((a, b) => (b.elevation || 0) - (a.elevation || 0))
      : spatialNode.children || [];

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
        descendantSpaceCache
      );
    }

    // Add direct spatial children elements for expanded nodes.
    if (hasDirectElements) {
      for (const elementId of elements) {
        const globalId = resolveTreeGlobalId(modelId, elementId, models);
        const entityType = dataStore.entities?.getTypeName(elementId) || 'Unknown';
        const entityName = dataStore.entities?.getName(elementId) || `${entityType} #${elementId}`;

        nodes.push({
          id: `element-${modelId}-${elementId}`,
          expressIds: [elementId],
          globalIds: [globalId],
          modelIds: [modelId],
          name: entityName,
          type: 'element',
          ifcType: entityType,
          depth: depth + 1,
          hasChildren: false,
          isExpanded: false,
          isVisible: true, // Computed lazily during render
        });
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
  unifiedStoreys: UnifiedStorey[]
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

          // If contribution expanded, show elements
          if (contribExpanded) {
            const dataStore = model?.ifcDataStore;
            for (const elementId of storey.elements) {
              const globalId = resolveTreeGlobalId(storey.modelId, elementId, models);
              const entityType = dataStore?.entities?.getTypeName(elementId) || 'Unknown';
              const entityName = dataStore?.entities?.getName(elementId) || `${entityType} #${elementId}`;

              nodes.push({
                id: `element-${storey.modelId}-${elementId}`,
                expressIds: [elementId],
                globalIds: [globalId],
                modelIds: [storey.modelId],
                name: entityName,
                type: 'element',
                ifcType: entityType,
                depth: 2,
                hasChildren: false,
                isExpanded: false,
                isVisible: true, // Computed lazily during render
              });
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
          descendantSpaceCache
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
        descendantSpaceCache
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
      descendantSpaceCache
    );
  }

  return nodes;
}

/** Build tree data grouped by IFC class instead of spatial hierarchy.
 *  Only includes entities that have geometry (visible in the 3D viewer).
 *  @param geometricIds Pre-computed set of global IDs with geometry (memoized by caller). */
export function buildTypeTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: Set<string>,
  isMultiModel: boolean,
  geometricIds?: Set<number>,
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

/** Filter nodes based on search query */
export function filterNodes(nodes: TreeNode[], searchQuery: string): TreeNode[] {
  if (!searchQuery.trim()) return nodes;
  const query = searchQuery.toLowerCase();
  return nodes.filter(node =>
    node.name.toLowerCase().includes(query) ||
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
