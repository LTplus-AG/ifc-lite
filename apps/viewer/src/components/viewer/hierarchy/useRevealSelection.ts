/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import type { TreeNode } from './types';

/** The subset of a `useVirtualizer` instance this hook needs — narrow enough
 *  to accept `storeysVirtualizer` / `modelsVirtualizer` / `virtualizer` in
 *  `HierarchyPanel.tsx` without importing virtualizer generics here. */
interface ScrollableVirtualizer {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
}

interface UseRevealSelectionParams {
  selectedEntityId: number | null;
  revealGlobalId: (globalId: number) => string | null;
  storeysNodes: TreeNode[];
  modelsNodes: TreeNode[];
  filteredNodes: TreeNode[];
  isMultiModel: boolean;
  storeysVirtualizer: ScrollableVirtualizer;
  modelsVirtualizer: ScrollableVirtualizer;
  virtualizer: ScrollableVirtualizer;
  /** Set to `true` at the top of the tree's own click handler. A selection
   *  that originated from a tree row click must not re-scroll the row that
   *  produced it (#5881) — it is already on screen. */
  fromTreeClickRef: { current: boolean };
}

/** Expand ancestors and scroll to a selection made outside the tree (3D
 *  viewport, search, BCF, context menu). Split into two effects because the
 *  target's ROW INDEX is only known once the (possibly newly expanded) node
 *  lists have re-rendered — `revealGlobalId` returns a node id, not an index
 *  into `storeysNodes`/`modelsNodes`/`filteredNodes`, and expanding ancestors
 *  is itself an async state update relative to this effect. */
export function useRevealSelection({
  selectedEntityId,
  revealGlobalId,
  storeysNodes,
  modelsNodes,
  filteredNodes,
  isMultiModel,
  storeysVirtualizer,
  modelsVirtualizer,
  virtualizer,
  fromTreeClickRef,
}: UseRevealSelectionParams): void {
  const pendingTargetRef = useRef<string | null>(null);

  // Effect A: a new selection arrives. Resolve which node it maps to (and
  // expand its ancestors) unless this selection came from the tree's own
  // click, which already put itself on screen.
  useEffect(() => {
    if (selectedEntityId == null) return;
    if (fromTreeClickRef.current) {
      fromTreeClickRef.current = false;
      return;
    }
    pendingTargetRef.current = revealGlobalId(selectedEntityId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revealGlobalId's own deps cover the tree/expansion state it reads
  }, [selectedEntityId]);

  // Effect B: the rendered lists catch up (e.g. after Effect A expanded a
  // collapsed ancestor) — find the pending target's row and scroll to it.
  useEffect(() => {
    const targetId = pendingTargetRef.current;
    if (targetId == null) return;

    if (isMultiModel) {
      const storeyIndex = storeysNodes.findIndex((n) => n.id === targetId);
      if (storeyIndex !== -1) {
        storeysVirtualizer.scrollToIndex(storeyIndex, { align: 'auto' });
        pendingTargetRef.current = null;
        return;
      }
      const modelIndex = modelsNodes.findIndex((n) => n.id === targetId);
      if (modelIndex !== -1) {
        modelsVirtualizer.scrollToIndex(modelIndex, { align: 'auto' });
        pendingTargetRef.current = null;
      }
      return;
    }

    const index = filteredNodes.findIndex((n) => n.id === targetId);
    if (index !== -1) {
      virtualizer.scrollToIndex(index, { align: 'auto' });
      pendingTargetRef.current = null;
    }
  }, [storeysNodes, modelsNodes, filteredNodes, isMultiModel, storeysVirtualizer, modelsVirtualizer, virtualizer]);
}
