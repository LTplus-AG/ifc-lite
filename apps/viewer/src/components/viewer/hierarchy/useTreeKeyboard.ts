/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WAI-ARIA APG tree-view keyboard behaviour (#5883), factored out of
 * `HierarchyPanel.tsx` so its three virtualized lists (spatial/grouped
 * single-model, multi-model Storeys, multi-model Models) share ONE
 * implementation rather than three copies. Roving `tabIndex`: exactly one
 * row (`activeNodeId`) is ever in the tab order when it is mounted; arrow/
 * Home/End/`*` move it, Enter/Space activates it via the caller's existing
 * click-handling rules (so Ctrl/Shift multi-select behaves identically from
 * click and keyboard), and a row's own DOM node registers itself via
 * `registerRow` so focus can follow the active id once the virtualizer has
 * actually mounted it.
 *
 * A tall tree's active row can be scrolled far outside the virtualizer's
 * mounted window (e.g. `End` on a 300-row tree) — no MOUNTED treeitem then
 * carries `tabIndex=0`, which would silently drop the tree out of the tab
 * sequence. `containerTabIndex` covers this structurally: it is 0 on the
 * tree container EXACTLY while the active row isn't mounted, and -1 once a
 * treeitem is carrying the tab stop itself, so the tree is never absent from
 * Tab order regardless of virtualization state (review round, #6139).
 *
 * Keys are handled entirely inside the tree's own `onKeyDown` (wired to the
 * scrolling container in `HierarchyPanel.tsx`); this never touches any
 * app-wide keyboard dispatcher (#5610's key layers), matching the issue's
 * "local to the focused tree" requirement.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TreeNode } from './types';

/** The subset of a `useVirtualizer` instance this hook needs. Kept narrow
 *  (mirrors `useRevealSelection`'s `ScrollableVirtualizer` from #6133/#5881,
 *  so the two hooks compose without either importing the other's module). */
interface ScrollableVirtualizer {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
  /** Only `index` is read — enough to know which rows are currently mounted,
   *  without depending on `@tanstack/react-virtual`'s full `VirtualItem`. */
  getVirtualItems: () => ReadonlyArray<{ index: number }>;
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
  containerRef: RefObject<HTMLElement | null>;
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
  /** `tabIndex` for the TREE CONTAINER itself: 0 exactly while the active
   *  row is not currently mounted (so the tree stays in the tab sequence
   *  even when the virtualizer hasn't caught up yet), -1 once a treeitem
   *  carries the tab stop. Wire to the same element as `onKeyDown`. */
  containerTabIndex: 0 | -1;
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

/** A string that changes exactly when the virtualizer's mounted window
 *  changes (first index, last index, count) — used only as an effect
 *  dependency, so the focus-follow effect below reruns when a previously
 *  unmounted row becomes available, rather than on every render. */
function renderedRangeKey(virtualItems: ReadonlyArray<{ index: number }>): string {
  if (virtualItems.length === 0) return 'empty';
  return `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}-${virtualItems.length}`;
}

export function useTreeKeyboard({
  nodes,
  containerRef,
  virtualizer,
  onToggleExpand,
  onActivate,
  getNodeName = (node) => node.name,
}: UseTreeKeyboardParams): UseTreeKeyboardResult {
  const [requestedActiveId, setRequestedActiveId] = useState<string | null>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const pendingFocusRef = useRef(false);
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

  // Read fresh on every render (cheap: one linear scan + one small array
  // scan) — whether the active row is among the virtualizer's CURRENTLY
  // MOUNTED items, not just logically present in `nodes`. Backs both
  // `containerTabIndex` and the focus-follow effect's re-trigger key.
  const virtualItems = virtualizer.getVirtualItems();
  const activeIndex = activeNodeId == null ? -1 : nodes.findIndex((n) => n.id === activeNodeId);
  const isActiveMounted = activeIndex !== -1 && virtualItems.some((v) => v.index === activeIndex);
  const containerTabIndex: 0 | -1 = activeNodeId != null && !isActiveMounted ? 0 : -1;

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

  // Focus-follows-active, driven by the ACTUAL rendered rows rather than a
  // timing guess: `moveTo` below asks the virtualizer to scroll first; once
  // that scroll causes a re-render whose mounted window includes the active
  // row (the `renderedRangeKey` dependency changes), this effect finds the
  // now-registered DOM node and focuses it. Same "wait for the list the
  // caller re-renders with" shape as #6133's reveal-selection effect B,
  // just keyed on the virtualizer's mounted range instead of a node list.
  const renderedKey = renderedRangeKey(virtualItems);
  useEffect(() => {
    // The first row is tabbable on mount, but focus stays wherever the user
    // left it until they actually navigate or focus a tree row — mounting
    // (or re-rendering) the tree must never steal focus from another control.
    if (activeNodeId == null || requestedActiveId == null) return;
    const container = containerRef.current;
    const treeOwnsFocus = container != null && container.contains(document.activeElement);
    // A virtualized row can unmount before its replacement mounts, leaving
    // focus on body. Keep following that keyboard move, but stop if the user
    // has focused another control in the meantime.
    const shouldFollow = treeOwnsFocus ||
      (pendingFocusRef.current && (
        document.activeElement === document.body || !document.activeElement?.isConnected
      ));
    if (!shouldFollow) pendingFocusRef.current = false;
    // Filtering or collapsing can remove the requested row; the fallback is
    // the first visible node, which may itself be outside the virtualizer's
    // mounted window — ask it to bring index 0 into range. Either way, the
    // `renderedKey` dependency below re-fires this effect once the target
    // (the fallback or the originally requested row) actually mounts, so
    // there is no rAF polling: `moveTo` already asked the virtualizer to
    // scroll, and this effect just waits for that to show up in the DOM.
    if (requestedActiveId !== activeNodeId) {
      // Consume the stale request even if search or another control now owns
      // focus. Only bring the fallback into view when focus is still here.
      setRequestedActiveId(shouldFollow ? activeNodeId : null);
      if (shouldFollow) virtualizer.scrollToIndex(0, { align: 'auto' });
    }
    if (!shouldFollow) return;
    const el = rowsRef.current.get(activeNodeId);
    if (el) {
      if (document.activeElement !== el) el.focus();
      pendingFocusRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderedKey IS the "rows changed" signal; recomputing it isn't a real new dep
  }, [activeNodeId, requestedActiveId, renderedKey, virtualizer, containerRef]);

  // Type-ahead buffer's timer must not fire (or leak) after the tree unmounts.
  useEffect(() => {
    return () => {
      if (typeaheadRef.current.timeout) clearTimeout(typeaheadRef.current.timeout);
    };
  }, []);

  const moveTo = useCallback(
    (index: number, activateWith?: NodeActivationModifiers) => {
      if (index < 0 || index >= nodes.length) return;
      const node = nodes[index];
      if (containerRef.current?.contains(document.activeElement)) pendingFocusRef.current = true;
      virtualizer.scrollToIndex(index, { align: 'auto' });
      setRequestedActiveId(node.id);
      // Shift+Up/Down extends selection to the newly focused row, exactly
      // like a Shift+click there would (APG: Ctrl+Up/Down moves focus only;
      // plain Up/Down also moves focus only — selection doesn't follow focus
      // in this multi-select tree).
      if (activateWith) onActivate(node, activateWith);
    },
    [nodes, virtualizer, onActivate, containerRef],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A row contains real buttons (chevron, visibility, actions). Their
      // own key handlers must not also activate or navigate the tree row —
      // bail out unless the event target IS the container (the active row
      // isn't mounted, #6139 review's virtualization fix) or a treeitem
      // itself (the normal case).
      if (e.target !== e.currentTarget &&
          (!(e.target instanceof Element) || e.target.getAttribute('role') !== 'treeitem')) return;
      // Resolve which row this keydown is ABOUT from the real DOM event
      // target first, falling back to `activeNodeId` state only when there
      // is none (the container-target case above). A native `focus()`
      // immediately followed by a synchronous `keydown` dispatch (a real
      // user's Tab-then-Enter, and how `HierarchyPanel.federation.test.tsx`'s
      // `activate()` helper drives this) can outrun the `onFocus`-driven
      // `setRequestedActiveId` state update reaching a re-render before this
      // handler runs — reading the DOM directly means this never depends on
      // that timing.
      const targetNodeId = (e.target as HTMLElement).closest?.('[data-node-id]')?.getAttribute('data-node-id') ?? null;
      const resolvedNodeId = targetNodeId ?? activeNodeId;
      const currentIndex = nodes.findIndex((n) => n.id === resolvedNodeId);
      if (currentIndex === -1) return;
      const node = nodes[currentIndex];
      const shiftExtend: NodeActivationModifiers | undefined = e.shiftKey
        ? { ctrlKey: false, metaKey: false, shiftKey: true }
        : undefined;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveTo(Math.min(currentIndex + 1, nodes.length - 1), shiftExtend);
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveTo(Math.max(currentIndex - 1, 0), shiftExtend);
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

  return { activeNodeId, getTabIndex, containerTabIndex, registerRow, onKeyDown, onRowFocus };
}
