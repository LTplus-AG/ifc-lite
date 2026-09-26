/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import type { TreeNode } from './types';
import { useModelTagView } from './ModelsSectionHeader';

const PART_TYPE_KEY = 'ifcbuildingelementpart';

/** #540: when the user has the merge-layers load setting on, hide
 *  `IfcBuildingElementPart` rows from the RENDERED trees — the Rust layer
 *  suppresses their meshes, so leaving the rows visible would lead to
 *  dead-clicks. Filter at the consumer (`HierarchyPanel`) rather than in
 *  `spatialHierarchy.ts`, so the spatial hierarchy itself stays intact for
 *  other consumers. Class grouping ("IfcBuildingElementPart (N)") and
 *  ifc-type nodes also expose an `ifcType`; strip those too since they would
 *  expand to empty groups after merge. */
export function useStrippedHierarchyNodes(
  rawFilteredNodes: TreeNode[],
  rawStoreysNodes: TreeNode[],
  rawModelsNodes: TreeNode[],
): { filteredNodes: TreeNode[]; storeysNodes: TreeNode[]; modelsNodes: TreeNode[] } {
  const mergeLayersHidesParts = useViewerStore((s) => s.mergeLayers);
  const stripPartNodes = useCallback(
    (nodes: TreeNode[]): TreeNode[] => {
      if (!mergeLayersHidesParts) return nodes;
      return nodes.filter((node) => {
        const t = node.ifcType?.toLowerCase();
        return !t || t !== PART_TYPE_KEY;
      });
    },
    [mergeLayersHidesParts],
  );
  const filteredNodes = useMemo(() => stripPartNodes(rawFilteredNodes), [stripPartNodes, rawFilteredNodes]);
  const storeysNodes = useMemo(() => stripPartNodes(rawStoreysNodes), [stripPartNodes, rawStoreysNodes]);
  // #4215 tag filter / By tag: rows only.
  const modelsNodes = useModelTagView(useMemo(() => stripPartNodes(rawModelsNodes), [stripPartNodes, rawModelsNodes]));
  return { filteredNodes, storeysNodes, modelsNodes };
}
