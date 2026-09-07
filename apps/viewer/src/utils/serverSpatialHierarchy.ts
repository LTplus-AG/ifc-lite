/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial hierarchy construction for the server data model conversion path.
 * Extracted from serverDataModel.ts to keep that module under its size budget.
 *
 * Builds the recursive SpatialNode tree and the SpatialHierarchy lookup maps
 * (by-storey/building/site/space, elevations, heights) from the server's
 * flat spatial-node list.
 */

import type { DataModel } from '@ifc-lite/server-client';
import {
  findStoreyByElevation,
  IfcTypeEnum,
  IfcTypeEnumFromString,
  isBuildingLikeSpatialType,
  isStoreyLikeSpatialType,
  type SpatialHierarchy,
  type SpatialNode,
} from '@ifc-lite/data';

/** Server spatial node shape (mirrors SpatialNode from @ifc-lite/server-client) */
interface ServerSpatialNode {
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

/** Maximum recursion depth for spatial tree building */
const MAX_SPATIAL_TREE_DEPTH = 100;

/**
 * Build recursive SpatialNode tree from server data
 *
 * @param nodeId - Entity ID of the spatial node to build
 * @param nodesMap - Map of all spatial nodes by entity ID
 * @param depth - Current recursion depth (default 0)
 * @param visited - Set of visited node IDs for cycle detection
 */
function buildSpatialNodeTree(
  nodeId: number,
  nodesMap: Map<number, ServerSpatialNode>,
  depth: number = 0,
  visited: Set<number> = new Set()
): SpatialNode {
  // Guard against excessive depth
  if (depth > MAX_SPATIAL_TREE_DEPTH) {
    throw new Error(`Spatial tree max depth (${MAX_SPATIAL_TREE_DEPTH}) exceeded at node ${nodeId}`);
  }

  // Guard against cycles
  if (visited.has(nodeId)) {
    throw new Error(`Cycle detected in spatial tree at node ${nodeId}`);
  }

  const node = nodesMap.get(nodeId);
  if (!node) {
    throw new Error(`Spatial node ${nodeId} not found`);
  }

  // Add current node to visited set
  visited.add(nodeId);

  const typeEnum = IfcTypeEnumFromString(node.type_name);

  const result: SpatialNode = {
    expressId: node.entity_id,
    type: typeEnum,
    name: node.name || node.type_name,
    elevation: node.elevation,
    children: node.children_ids.map((childId: number) =>
      buildSpatialNodeTree(childId, nodesMap, depth + 1, visited)
    ),
    elements: node.element_ids,
  };

  // Remove from visited after processing (allows node in different branches)
  visited.delete(nodeId);

  return result;
}

/**
 * Build spatial hierarchy from server data model
 */
export function buildSpatialHierarchy(
  dataModel: DataModel,
  entityToPsets: Map<number, Array<{ pset_name: string; properties: Array<{ property_name: string; property_value: string | number | boolean | null }> }>>
): SpatialHierarchy {
  const byStorey = new Map<number, number[]>();
  const byBuilding = new Map<number, number[]>();
  const bySite = new Map<number, number[]>();
  const bySpace = new Map<number, number[]>();
  const storeyElevations = new Map<number, number>();
  const storeyHeights = new Map<number, number>();

  const nodesMap = new Map<number, ServerSpatialNode>(
    dataModel.spatialHierarchy.nodes.map((n: ServerSpatialNode) => [n.entity_id, n])
  );

  // Build lookup maps from spatial hierarchy data
  for (const node of dataModel.spatialHierarchy.nodes) {
    const typeEnum = IfcTypeEnumFromString(node.type_name);
    if (isStoreyLikeSpatialType(typeEnum)) {
      byStorey.set(node.entity_id, node.element_ids);
      if (node.elevation !== undefined) {
        storeyElevations.set(node.entity_id, node.elevation);
      }
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      byBuilding.set(node.entity_id, node.element_ids);
    } else if (typeEnum === IfcTypeEnum.IfcSite) {
      bySite.set(node.entity_id, node.element_ids);
    } else if (typeEnum === IfcTypeEnum.IfcSpace) {
      bySpace.set(node.entity_id, node.element_ids);
    }
  }

  // Extract storey heights from property sets
  for (const storeyId of byStorey.keys()) {
    const psets = entityToPsets.get(storeyId);
    if (!psets) continue;
    for (const pset of psets) {
      for (const prop of pset.properties) {
        const propName = prop.property_name.toLowerCase();
        if (propName === 'grossheight' || propName === 'netheight' || propName === 'height') {
          const val = typeof prop.property_value === 'number' ? prop.property_value : parseFloat(String(prop.property_value));
          if (!isNaN(val) && val > 0) {
            storeyHeights.set(storeyId, val);
            break;
          }
        }
      }
      if (storeyHeights.has(storeyId)) break;
    }
  }

  // Fallback: calculate heights from elevation differences
  if (storeyHeights.size === 0 && storeyElevations.size > 1) {
    const sortedStoreys = Array.from(storeyElevations.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sortedStoreys.length - 1; i++) {
      const [storeyId, elevation] = sortedStoreys[i];
      const nextElevation = sortedStoreys[i + 1][1];
      const height = nextElevation - elevation;
      if (height > 0) {
        storeyHeights.set(storeyId, height);
      }
    }
    console.log(`[serverDataModel] Calculated ${storeyHeights.size} storey heights from elevation differences`);
  }

  // Build project node tree
  const projectNode = buildSpatialNodeTree(dataModel.spatialHierarchy.project_id, nodesMap);

  const findPath = (node: SpatialNode, targetId: number, path: SpatialNode[] = []): SpatialNode[] => {
    const nextPath = [...path, node];
    if (node.elements.includes(targetId)) {
      return nextPath;
    }
    for (const child of node.children) {
      const childPath = findPath(child, targetId, nextPath);
      if (childPath.length > 0) {
        return childPath;
      }
    }
    return [];
  };

  return {
    project: projectNode,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey: dataModel.spatialHierarchy.element_to_storey,
    getStoreyElements: (storeyId: number) => byStorey.get(storeyId) || [],
    // Canonical resolver shared with the parser path (#1841). This used to
    // always snap to the nearest storey while the parser returned null beyond
    // 1m, so the same Z resolved to a different storey depending on whether the
    // model came from the server or from wasm.
    getStoreyByElevation: (z: number) => findStoreyByElevation(storeyElevations, z),
    getContainingSpace: (elementId: number) => {
      return dataModel.spatialHierarchy.element_to_space.get(elementId) || null;
    },
    getPath: (elementId: number) => {
      return findPath(projectNode, elementId);
    },
  };
}
