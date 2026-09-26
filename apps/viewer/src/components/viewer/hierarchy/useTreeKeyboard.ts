/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WAI-ARIA APG tree-view keyboard behaviour (#5883), factored out of
 * `HierarchyPanel.tsx` so its three virtualized lists (spatial/grouped
 * single-model, multi-model Storeys, multi-model Models) share ONE
 * implementation rather than three copies. Roving `tabIndex`: exactly one
 * row (`activeNodeId`) is ever in the tab order; arrow/Home/End/`*`
 * move it, Enter/Space activates it via the caller's existing click-handling
 * rules (so Ctrl/Shift multi-select behaves identically from click and
 * keyboard), and a row's own DOM node registers itself via `registerRow` so
 * focus can follow the active id once the virtualizer has actually mounted
 * that row — it may not be mounted yet when focus should move to it.
 *
 * Keys are handled entirely inside the tree's own `onKeyDown` (wired to the
 * scrolling container in `HierarchyPanel.tsx`); this never touches any
 * app-wide keyboard dispatcher (#5610's key layers), matching the issue's
 * "local to the focused tree" requirement.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from './types';

/** The subset of a `useVirtualizer` instance this hook needs. Kept narrow
 *  (mirrors `useRevealSelection`'s `ScrollableVirtualizer` from #6133/#5881,
 *  so the two hooks compose without either importing the other's module). */
interface ScrollableVirtualizer {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
}

/** The modifier keys `handleNodeClick`'s existing multi-select rules read
 *  (Ctrl/Cmd toggles, Shift extends a range). Both `React.MouseEvent` and
 *  `React.KeyboardEvent` satisfy this structurally, so Enter/Space can drive
 *  the exact same activation function a click does, no cast needed. */
export interface NodeActivationModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

interface UseTreeKeyboardParams {
  /** The flat, depth-first node list THIS tree instance renders (one of
   *  `storeysNodes` / `modelsNodes` / `filteredNodes` — never mixed). */
  nodes: TreeNode[];
  virtualizer: ScrollableVirtualizer;
  /** Expand/collapse one node by id (no-ops during search, same as the
   *  chevron button — the hook doesn't special-case that, it just calls
   *  through). */
  onToggleExpand: (nodeId: string) => void;
  /** Select/activate a node exactly like a click on its row would. */
  onActivate: (node: TreeNode, modifiers: NodeActivationModifiers) => void;
  /** Typeahead matches against the row's visible name. */
  getNodeName?: (node: TreeNode) => string;
}

export interface UseTreeKeyboardResult {
  /** The id of the row currently in the tab order (roving tabIndex). */
  activeNodeId: string | null;
  /** `tabIndex` for a given row: 0 for the active row, -1 otherwise. */
  getTabIndex: (nodeId: string) => 0 | -1;
  /** Ref callback a row passes its own DOM node to, so focus can find it
   *  once mounted. Pass `null` on unmount to avoid a stale focus target. */
  registerRow: (nodeId: string, el: HTMLElement | null) => void;
  /** Wire to the tree container's `onKeyDown` (role="tree" element). */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Wire to each row's `onFocus` so a mouse/Tab focus that lands on a row
   *  directly (not via arrow-key navigation) updates the roving tabIndex. */
  onRowFocus: (nodeId: string) => void;
}

const TYPEAHEAD_RESET_MS = 500;

/** First index at or after `from`, scanning forward, whose name starts with
 *  `query` (case-insensitive), wrapping around the full list once. */
function findTypeaheadMatch(
  nodes: TreeNode[],
  getName: (node: TreeNode) => string,
  from: number,
  query: string,
): number {
  const q = query.toLowerCase();
  for (let step = 1; step <= nodes.length; step++) {
    const i = (from + step) % nodes.length;
    if (getName(nodes[i]).toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

/** Nearest earlier node whose depth is exactly one less than `depth` — the
 *  parent, given a valid depth-first, one-level-per-step node list (the same
 *  invariant `treeDataBuilder.findNodePath` relies on). Returns -1 at the root. */
function findParentIndex(nodes: TreeNode[], from: number, depth: number): number {
  if (depth === 0) return -1;
  for (let i = from - 1; i >= 0; i--) {
    if (nodes[i].depth <= depth - 1) return i;
  }
  return -1;
}

export function useTreeKeyboard({
  nodes,
  virtualizer,
  onToggleExpand,
  onActivate,
  getNodeName = (node) => node.name,
}: UseTreeKeyboardParams): UseTreeKeyboardResult {
  const [requestedActiveId, setRequestedActiveId] = useState<string | null>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const typeaheadRef = useRef<{ buffer: string; timeout: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timeout: null,
  });

  // Derived, not stateful: falls back to the first row whenever the
  // requested id isn't (or isn't yet) in this list — covers both "nothing
  // chosen yet" and "the active row was filtered/collapsed away".
  const activeNodeId = useMemo(() => {
    if (requestedActiveId != null && nodes.some((n) => n.id === requestedActiveId)) return requestedActiveId;
    return nodes[0]?.id ?? null;
  }, [nodes, requestedActiveId]);

  const registerRow = useCallback((nodeId: string, el: HTMLElement | null) => {
    if (el) rowsRef.current.set(nodeId, el);
    else rowsRef.current.delete(nodeId);
  }, []);

  const getTabIndex = useCallback(
    (nodeId: string): 0 | -1 => (nodeId === activeNodeId ? 0 : -1),
    [activeNodeId],
  );

  const onRowFocus = useCallback((nodeId: string) => {
    setRequestedActiveId(nodeId);
  }, []);

  // Focus-follows-active: the target row may not be mounted yet (virtualizer
  // window), so poll a few animation frames after asking the virtualizer to
  // scroll to it rather than assuming one render is enough.
  useEffect(() => {
    // The first row is tabbable on mount, but focus stays wherever the user
    // left it until they actually navigate or focus a tree row.
    if (activeNodeId == null || requestedActiveId == null) return;
    // Filtering or collapsing can remove the requested row. The fallback is
    // the first visible node, which may be outside the virtualizer window.
    if (requestedActiveId !== activeNodeId) virtualizer.scrollToIndex(0, { align: 'auto' });
    let cancelled = false;
    let frame = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const el = rowsRef.current.get(activeNodeId);
      if (el) {
        el.focus();
        return;
      }
      frame += 1;
      if (frame < 10) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
    };
  }, [activeNodeId, requestedActiveId, virtualizer]);

  const moveTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= nodes.length) return;
      const node = nodes[index];
      virtualizer.scrollToIndex(index, { align: 'auto' });
      setRequestedActiveId(node.id);
    },
    [nodes, virtualizer],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A row contains real buttons (chevron, visibility, actions). Their
      // own key handlers must not also activate or navigate the tree row.
      if (e.target !== e.currentTarget &&
          (!(e.target instanceof Element) || e.target.getAttribute('role') !== 'treeitem')) return;
      const currentIndex = nodes.findIndex((n) => n.id === activeNodeId);
      if (currentIndex === -1) return;
      const node = nodes[currentIndex];

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(Math.min(currentIndex + 1, nodes.length - 1));
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(Math.max(currentIndex - 1, 0));
          return;
        case 'Home':
          e.preventDefault();
          moveTo(0);
          return;
        case 'End':
          e.preventDefault();
          moveTo(nodes.length - 1);
          return;
        case 'ArrowRight': {
          e.preventDefault();
          if (!node.hasChildren) return;
          if (!node.isExpanded) {
            onToggleExpand(node.id);
            return;
          }
          // Already open: move to the first child (immediately next in a
          // depth-first, one-level-per-step list).
          if (currentIndex + 1 < nodes.length && nodes[currentIndex + 1].depth === node.depth + 1) {
            moveTo(currentIndex + 1);
          }
          return;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          if (node.hasChildren && node.isExpanded) {
            onToggleExpand(node.id);
            return;
          }
          const parentIndex = findParentIndex(nodes, currentIndex, node.depth);
          if (parentIndex !== -1) moveTo(parentIndex);
          return;
        }
        case 'Enter':
        case ' ':
          e.preventDefault();
          onActivate(node, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
          return;
        case '*': {
          e.preventDefault();
          // Expand every sibling of the current node (same parent, same
          // depth) that has children and isn't already expanded.
          const parentIndex = findParentIndex(nodes, currentIndex, node.depth);
          for (let i = parentIndex + 1; i < nodes.length && nodes[i].depth >= node.depth; i++) {
            if (nodes[i].depth === node.depth && nodes[i].hasChildren && !nodes[i].isExpanded) {
              onToggleExpand(nodes[i].id);
            }
          }
          return;
        }
        default:
          break;
      }

      // Type-ahead: a single printable character with no modifier extends
      // the buffer and jumps to the next matching row name; any other key
      // (or a pause longer than the reset window) starts a fresh buffer.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const ta = typeaheadRef.current;
        if (ta.timeout) clearTimeout(ta.timeout);
        ta.buffer += e.key;
        ta.timeout = setTimeout(() => {
          ta.buffer = '';
        }, TYPEAHEAD_RESET_MS);
        const matchIndex = findTypeaheadMatch(nodes, getNodeName, currentIndex, ta.buffer);
        if (matchIndex !== -1) moveTo(matchIndex);
      }
    },
    [activeNodeId, getNodeName, moveTo, nodes, onActivate, onToggleExpand],
  );

  return { activeNodeId, getTabIndex, registerRow, onKeyDown, onRowFocus };
}
