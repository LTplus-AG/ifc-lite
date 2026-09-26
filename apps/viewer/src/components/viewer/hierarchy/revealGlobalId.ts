/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, HierarchyMode } from '@/store';
import type {
  TreeNode,
  UnifiedStorey,
  HierarchySortMode,
  ExpansionLookup,
} from './types';
import {
  buildTreeData,
  buildTypeTree,
  buildIfcTypeTree,
  buildMaterialTree,
  buildGroupTree,
  type AuthoredProduct,
  type GroupSubFilter,
  type GeorefMutationsByModel,
} from './treeDataBuilder';
import { findNodePath } from './findNodePath';

const EXPAND_ALL: ExpansionLookup = { has: () => true };

/** A node this reveal feature can land a selection on — the same three leaf
 *  types both `useRevealGlobalId` below and `useRevealSelection`'s cheap
 *  already-visible check (#5881 perf review) match against, so the two
 *  never drift out of sync. */
export function matchesRevealTarget(node: TreeNode, globalId: number): boolean {
  return (node.type === 'element' || node.type === 'IfcSpace' || node.type === 'IfcSpatialZone')
    && node.globalIds.includes(globalId);
}

/** The same grouping-mode switch `useHierarchyTree.ts`'s `treeData` memo
 *  drives, extracted so `useExpandedTreeForGrouping` below can build the
 *  ACTIVE grouping's tree at a different expansion (fully expanded) without
 *  a second copy of the switch (#5881). */
export function buildTreeForGrouping(
  groupingMode: HierarchyMode,
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expansion: ExpansionLookup,
  isMultiModel: boolean,
  unifiedStoreys: UnifiedStorey[],
  sortMode: HierarchySortMode,
  geometricIds: Set<number>,
  classTreeIds: Set<number>,
  authoredProducts: AuthoredProduct[],
  groupFilter: GroupSubFilter,
  geometryReadyModelIds: ReadonlySet<string>,
  georefMutations: GeorefMutationsByModel,
  mutationViews: Map<string, MutablePropertyView>,
): TreeNode[] {
  const treeOverlay = (modelId: string) => mutationViews.get(modelId); // deletes/retypes, re-run per mutationVersion (#5249)
  if (groupingMode === 'type') {
    return buildTypeTree(models, ifcDataStore, expansion, isMultiModel, classTreeIds, authoredProducts, geometryReadyModelIds, treeOverlay);
  }
  if (groupingMode === 'ifc-type') {
    return buildIfcTypeTree(models, ifcDataStore, expansion, isMultiModel, geometricIds, geometryReadyModelIds, treeOverlay);
  }
  if (groupingMode === 'material') {
    return buildMaterialTree(models, ifcDataStore, expansion, isMultiModel, geometricIds, geometryReadyModelIds);
  }
  if (groupingMode === 'groups') {
    return buildGroupTree(models, ifcDataStore, expansion, isMultiModel, geometricIds, groupFilter, treeOverlay);
  }
  return buildTreeData(models, ifcDataStore, expansion, isMultiModel, unifiedStoreys, sortMode, geometricIds, geometryReadyModelIds, georefMutations);
}

interface TreeBuildParams {
  groupingMode: HierarchyMode;
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null | undefined;
  isMultiModel: boolean;
  unifiedStoreys: UnifiedStorey[];
  sortMode: HierarchySortMode;
  geometricIds: Set<number>;
  classTreeIds: Set<number>;
  authoredProducts: AuthoredProduct[];
  groupFilter: GroupSubFilter;
  geometryReadyModelIds: ReadonlySet<string>;
  georefMutations: GeorefMutationsByModel;
  mutationViews: Map<string, MutablePropertyView>;
  mutationVersion: number;
}

/** Build the fully expanded projection on the first reveal lookup for a set
 *  of tree inputs. Streamed geometry updates invalidate the cache without
 *  rebuilding it during render when nobody has asked to reveal (#6133). */
export function useExpandedTreeForGrouping(params: TreeBuildParams): () => TreeNode[] {
  const {
    groupingMode, models, ifcDataStore, isMultiModel, unifiedStoreys, sortMode, geometricIds,
    classTreeIds, authoredProducts, groupFilter, geometryReadyModelIds, georefMutations,
    mutationViews, mutationVersion,
  } = params;
  const cacheRef = useRef<{ inputs: readonly unknown[]; tree: TreeNode[] } | null>(null);
  const inputs = [groupingMode, models, ifcDataStore, isMultiModel, unifiedStoreys, sortMode,
    geometricIds, classTreeIds, authoredProducts, groupFilter, geometryReadyModelIds,
    georefMutations, mutationViews, mutationVersion] as const;
  return () => {
    const cached = cacheRef.current;
    if (cached && cached.inputs.every((value, i) => Object.is(value, inputs[i]))) return cached.tree;
    const tree = buildTreeForGrouping(
      groupingMode, models, ifcDataStore, EXPAND_ALL, isMultiModel, unifiedStoreys, sortMode,
      geometricIds, classTreeIds, authoredProducts, groupFilter, geometryReadyModelIds, georefMutations, mutationViews,
    );
    cacheRef.current = { inputs, tree };
    return tree;
  };
}

/** Reveal a selection made outside the tree (viewport click, search, BCF,
 *  context menu): find the node under the ACTIVE grouping's fully expanded
 *  projection, built lazily by `getExpandedTree`, via `findNodePath` (reusing `filterNodes`'s
 *  ancestor walk, not a second one), and expand only the ancestors that are
 *  missing so an already-visible target doesn't trigger a needless render
 *  (#5881). */
export function useRevealGlobalId(
  getExpandedTree: () => TreeNode[],
  expandedNodes: Set<string>,
  setExpandedNodes: Dispatch<SetStateAction<Set<string>>>,
): (globalId: number) => string | null {
  return useCallback((globalId: number): string | null => {
    const found = findNodePath(getExpandedTree(), (node) => matchesRevealTarget(node, globalId));
    if (!found) return null;
    if (found.ancestorIds.some((id) => !expandedNodes.has(id))) {
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        for (const id of found.ancestorIds) next.add(id);
        return next;
      });
    }
    return found.targetId;
  }, [getExpandedTree, expandedNodes, setExpandedNodes]);
}
