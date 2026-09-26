/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wires `useTreeKeyboard` + `computeAriaTreeAttrs` to `HierarchyPanel.tsx`'s
 * three virtualized lists in one call (#5883), so the panel itself only
 * destructures the result instead of repeating the per-list boilerplate
 * three times (keeps the panel under its module-size allowlist row).
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import type { TreeNode } from './types';
import { computeAriaTreeAttrs, type AriaTreeAttrs } from './ariaTreeAttrs';
import { useTreeKeyboard, type NodeActivationModifiers, type UseTreeKeyboardResult } from './useTreeKeyboard';

interface ScrollableVirtualizer {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
  getVirtualItems: () => ReadonlyArray<{ index: number }>;
}

interface UseHierarchyTreeKeyboardParams {
  storeysNodes: TreeNode[];
  modelsNodes: TreeNode[];
  filteredNodes: TreeNode[];
  storeysVirtualizer: ScrollableVirtualizer;
  modelsVirtualizer: ScrollableVirtualizer;
  virtualizer: ScrollableVirtualizer;
  toggleExpand: (nodeId: string) => void;
  groupingMode: string;
  /** A `model-header` row's click is handled by its own `onModelHeaderClick`
   *  (select model + toggle expand), not `handleNodeClick` — Enter/Space
   *  mirrors that one branch, then delegates everything else to the exact
   *  function a mouse click uses so Ctrl/Shift multi-select behaves
   *  identically from keyboard and mouse. */
  handleNodeClick: (node: TreeNode, e: NodeActivationModifiers) => void;
  handleModelHeaderClick: (modelId: string, nodeId: string, hasChildren: boolean) => void;
}

export interface UseHierarchyTreeKeyboardResult {
  storeysAriaAttrs: AriaTreeAttrs[];
  modelsAriaAttrs: AriaTreeAttrs[];
  filteredAriaAttrs: AriaTreeAttrs[];
  storeysTreeKeyboard: UseTreeKeyboardResult;
  modelsTreeKeyboard: UseTreeKeyboardResult;
  legacyTreeKeyboard: UseTreeKeyboardResult;
  /** Accessible label for the single-model/grouped tree — the exact title
   *  the visible `SectionHeader` renders, so the tree's ARIA name never
   *  drifts from what a sighted user reads above it. */
  singleTreeSectionTitle: string;
}

export function useHierarchyTreeKeyboard({
  storeysNodes, modelsNodes, filteredNodes,
  storeysVirtualizer, modelsVirtualizer, virtualizer,
  toggleExpand, groupingMode, handleNodeClick, handleModelHeaderClick,
}: UseHierarchyTreeKeyboardParams): UseHierarchyTreeKeyboardResult {
  const { t } = useTranslation();

  const handleNodeActivate = useCallback((node: TreeNode, modifiers: NodeActivationModifiers) => {
    if (node.type === 'model-header' && node.id !== 'models-header') {
      handleModelHeaderClick(node.modelIds[0], node.id, node.hasChildren);
      return;
    }
    handleNodeClick(node, modifiers);
  }, [handleModelHeaderClick, handleNodeClick]);

  const storeysAriaAttrs = useMemo(() => computeAriaTreeAttrs(storeysNodes), [storeysNodes]);
  const modelsAriaAttrs = useMemo(() => computeAriaTreeAttrs(modelsNodes), [modelsNodes]);
  const filteredAriaAttrs = useMemo(() => computeAriaTreeAttrs(filteredNodes), [filteredNodes]);

  const storeysTreeKeyboard = useTreeKeyboard({
    nodes: storeysNodes, virtualizer: storeysVirtualizer, onToggleExpand: toggleExpand, onActivate: handleNodeActivate,
  });
  const modelsTreeKeyboard = useTreeKeyboard({
    nodes: modelsNodes, virtualizer: modelsVirtualizer, onToggleExpand: toggleExpand, onActivate: handleNodeActivate,
  });
  const legacyTreeKeyboard = useTreeKeyboard({
    nodes: filteredNodes, virtualizer, onToggleExpand: toggleExpand, onActivate: handleNodeActivate,
  });

  const singleTreeSectionTitle = groupingMode === 'spatial' ? t('hierarchy.panel.sectionTitle.spatial')
    : groupingMode === 'type' ? t('hierarchy.panel.sectionTitle.byClass')
    : groupingMode === 'material' ? t('hierarchy.panel.sectionTitle.byMaterial')
    : groupingMode === 'groups' ? t('hierarchy.panel.sectionTitle.byGroup')
    : t('hierarchy.panel.sectionTitle.byType');

  return {
    storeysAriaAttrs, modelsAriaAttrs, filteredAriaAttrs,
    storeysTreeKeyboard, modelsTreeKeyboard, legacyTreeKeyboard,
    singleTreeSectionTitle,
  };
}
