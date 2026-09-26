/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore, type HierarchyMode } from '@/store';
import type { TreeNode } from './types';
import { matchesRevealTarget } from './revealGlobalId';

/** The subset of a `useVirtualizer` instance this hook needs — narrow enough
 *  to accept `storeysVirtualizer` / `modelsVirtualizer` / `virtualizer` in
 *  `HierarchyPanel.tsx` without importing virtualizer generics here. */
interface ScrollableVirtualizer {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
}

interface UseRevealSelectionParams {
  selectedEntityId: number | null;
  groupingMode: HierarchyMode;
  revealGlobalId: (globalId: number) => string | null;
  storeysNodes: TreeNode[];
  modelsNodes: TreeNode[];
  filteredNodes: TreeNode[];
  isMultiModel: boolean;
  storeysVirtualizer: ScrollableVirtualizer;
  modelsVirtualizer: ScrollableVirtualizer;
  virtualizer: ScrollableVirtualizer;
}

/** First node across `storeysNodes`+`modelsNodes` (multi-model) or
 *  `filteredNodes` (single-model) — i.e. the CURRENTLY RENDERED, collapsed-
 *  aware flat list — matching `globalId`, or `null`. A perf-review finding
 *  (#5881): checking this small, already-materialised list is orders of
 *  magnitude cheaper than `revealGlobalId`'s full-tree walk, and covers the
 *  common case where the target is already on screen. */
function findAlreadyVisibleTargetId(
  isMultiModel: boolean,
  storeysNodes: TreeNode[],
  modelsNodes: TreeNode[],
  filteredNodes: TreeNode[],
  globalId: number,
): string | null {
  if (isMultiModel) {
    for (const node of storeysNodes) if (matchesRevealTarget(node, globalId)) return node.id;
    for (const node of modelsNodes) if (matchesRevealTarget(node, globalId)) return node.id;
    return null;
  }
  for (const node of filteredNodes) if (matchesRevealTarget(node, globalId)) return node.id;
  return null;
}

/** Expand ancestors and scroll to a selection made outside the tree (3D
 *  viewport, search, BCF, context menu). Split into two effects because the
 *  target's ROW INDEX is only known once the (possibly newly expanded) node
 *  lists have re-rendered — `revealGlobalId` returns a node id, not an index
 *  into `storeysNodes`/`modelsNodes`/`filteredNodes`, and expanding ancestors
 *  is itself an async state update relative to this effect.
 *
 *  Returns `markFromTreeClick`, to be called from a `finally` block wrapping
 *  the tree's own click handler, once the click has settled on its final
 *  selection: a selection that originated from a tree row click must not
 *  re-scroll the row that produced it (#5881) — it is already on screen.
 *
 *  The click guard keys on `{ id, revision }`, not `id` alone (adversarial
 *  review, #5881): `selectionRevision` is the store's own monotonic counter,
 *  bumped by `setSelectedEntityId` on EVERY call — including a repeat click
 *  on an already-selected row, where `id` never changes. Effect A's
 *  dependency is `[selectionRevision, groupingMode]`, so it fires on every
 *  dispatch (not only on an id CHANGE) and clears the ref UNCONDITIONALLY at
 *  its top, before any early return — a deselect (`setSelectedEntityId(null)`)
 *  still consumes a pending mark, so a stale mark can never survive to
 *  falsely match a LATER, genuinely outside, re-selection of the same id.
 *  Depending on `groupingMode` too means a selection held across a grouping
 *  tab switch is re-revealed in the new grouping. */
export function useRevealSelection({
  selectedEntityId,
  groupingMode,
  revealGlobalId,
  storeysNodes,
  modelsNodes,
  filteredNodes,
  isMultiModel,
  storeysVirtualizer,
  modelsVirtualizer,
  virtualizer,
}: UseRevealSelectionParams): { markFromTreeClick: () => void } {
  const pendingTargetRef = useRef<string | null>(null);
  const fromTreeClickRef = useRef<{ id: number | null; revision: number } | undefined>(undefined);
  const markFromTreeClick = useCallback(() => {
    const state = useViewerStore.getState();
    fromTreeClickRef.current = { id: state.selectedEntityId, revision: state.selectionRevision };
  }, []);

  const selectionRevision = useViewerStore((s) => s.selectionRevision);

  // Effect A: a selection was DISPATCHED (every dispatch bumps
  // `selectionRevision`, whether or not `selectedEntityId`'s value actually
  // changed). Resolve which node it maps to (and expand its ancestors, or
  // just note it's already visible) unless this dispatch came from the
  // tree's own click, which already put itself on screen.
  useEffect(() => {
    const marked = fromTreeClickRef.current;
    fromTreeClickRef.current = undefined; // unconditional: even the null/deselect run consumes it
    if (selectedEntityId == null) return;
    if (marked && marked.id === selectedEntityId && marked.revision === selectionRevision) return;

    const visibleId = findAlreadyVisibleTargetId(isMultiModel, storeysNodes, modelsNodes, filteredNodes, selectedEntityId);
    pendingTargetRef.current = visibleId ?? revealGlobalId(selectedEntityId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revealGlobalId/node lists read fresh via closure; selectionRevision is the dispatch signal
  }, [selectionRevision, groupingMode]);

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

  return { markFromTreeClick };
}
