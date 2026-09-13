/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  isSpaceLikeSpatialType,
  isSpatialStructureType,
  isStoreyLikeSpatialType,
  type SpatialNode,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { NodeType } from './types';

function collectDescendantSpaceElements(
  spatialNode: SpatialNode,
  hierarchy: IfcDataStore['spatialHierarchy'],
  cache: Map<number, Set<number>>,
): Set<number> {
  const cached = cache.get(spatialNode.expressId);
  if (cached) return cached;

  const elementIds = new Set<number>();
  for (const child of spatialNode.children ?? []) {
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

/** Index a spatial hierarchy once for unified-storey lookups. */
export function indexSpatialNodes(root: SpatialNode): Map<number, SpatialNode> {
  const nodes = new Map<number, SpatialNode>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.set(node.expressId, node);
    pending.push(...(node.children ?? []));
  }
  return nodes;
}

/** Direct rows for a spatial node, excluding contents rolled up under spaces. */
export function getSpatialNodeElements(
  spatialNode: SpatialNode,
  dataStore: IfcDataStore,
  nodeType: NodeType,
  descendantSpaceCache: Map<number, Set<number>>,
): number[] {
  if (isSpaceLikeSpatialType(spatialNode.type)) {
    return (dataStore.spatialHierarchy?.bySpace.get(spatialNode.expressId) as number[]) || [];
  }
  if (!isStoreyLikeSpatialType(spatialNode.type)) {
    if (!isSpatialStructureType(spatialNode.type)) return [];
    return spatialNode.elements || [];
  }
  if (nodeType !== 'IfcBuildingStorey') return [];

  const storeyElements =
    (dataStore.spatialHierarchy?.byStorey.get(spatialNode.expressId) as number[]) || [];
  const descendantSpaceElements = collectDescendantSpaceElements(
    spatialNode,
    dataStore.spatialHierarchy,
    descendantSpaceCache,
  );
  return storeyElements.filter((elementId) => !descendantSpaceElements.has(elementId));
}
