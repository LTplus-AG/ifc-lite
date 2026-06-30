/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explorer-style multi-select for the clickable element lists across the viewer
 * (results lists, hierarchy, ...). A plain click selects one row; Ctrl/Cmd+click
 * toggles a row's membership; Shift+click selects the contiguous range from the
 * last anchor to the clicked row. (#1463)
 *
 * Both selection channels are kept in sync so the renderer highlight (the
 * global-id set `selectedEntityIds`) and the model-aware set
 * (`selectedEntitiesSet` / `selectedEntities`, used by the properties panel and
 * other panels' checkbox state) agree - see [[project_viewer_two_selection_channels]].
 *
 * The hook owns the anchor index in a ref, so each list instance tracks its own
 * "last clicked" row. Callers pass the CURRENT ordered, selectable items (group
 * headers and other non-rows filtered out) plus the clicked index and the
 * mouse-event modifier keys.
 */

import { useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';

/** One selectable row: the renderer highlight id plus the model-aware ref. */
export interface MultiSelectItem {
  /** Global id for renderer highlight (single-model: === expressId). */
  globalId: number;
  modelId: string;
  expressId: number;
}

/** The modifier-key subset of a mouse/keyboard event we care about. */
export interface SelectModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type MultiSelectClickHandler = (
  items: ReadonlyArray<MultiSelectItem>,
  index: number,
  modifiers: SelectModifiers,
) => void;

export interface ListMultiSelect {
  /** Handle a row click (single / toggle / range per modifier keys). */
  select: MultiSelectClickHandler;
  /**
   * Record the anchor for a row index WITHOUT changing the selection. A panel
   * that routes plain clicks through its own (legacy) selection path calls this
   * so a following Shift+click still extends a contiguous range from that
   * row. (#1463)
   */
  setAnchor: (index: number) => void;
}

/**
 * Resolve a list click into a selection intent - pure so the Explorer-style
 * precedence (Shift range beats Ctrl/Cmd toggle beats plain replace) is unit
 * testable independent of the store. `anchor` is the last-clicked index, or
 * null when there is none yet. (#1463)
 */
export type SelectionIntent =
  | { kind: 'range'; lo: number; hi: number }
  | { kind: 'toggle'; index: number }
  | { kind: 'single'; index: number };

export function resolveListSelection(
  anchor: number | null,
  index: number,
  itemCount: number,
  modifiers: SelectModifiers,
): SelectionIntent {
  // Shift extends from the anchor (when there is a valid one in range).
  if (modifiers.shiftKey && anchor !== null && anchor >= 0 && anchor < itemCount) {
    return { kind: 'range', lo: Math.min(anchor, index), hi: Math.max(anchor, index) };
  }
  if (modifiers.ctrlKey || modifiers.metaKey) {
    return { kind: 'toggle', index };
  }
  return { kind: 'single', index };
}

export function useEntityListMultiSelect(): ListMultiSelect {
  const anchorRef = useRef<number | null>(null);

  const clearEntitySelection = useViewerStore((s) => s.clearEntitySelection);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const addEntitiesToSelection = useViewerStore((s) => s.addEntitiesToSelection);
  const toggleSelection = useViewerStore((s) => s.toggleSelection);
  const toggleEntitySelection = useViewerStore((s) => s.toggleEntitySelection);

  // Replace the selection with exactly these rows, across both channels.
  const selectExact = useCallback(
    (rows: ReadonlyArray<MultiSelectItem>) => {
      clearEntitySelection();
      if (rows.length === 0) return;
      setSelectedEntityIds(rows.map((r) => r.globalId));
      addEntitiesToSelection(rows.map((r) => ({ modelId: r.modelId, expressId: r.expressId })));
    },
    [clearEntitySelection, setSelectedEntityIds, addEntitiesToSelection],
  );

  const setAnchor = useCallback((index: number) => {
    anchorRef.current = index;
  }, []);

  const select = useCallback<MultiSelectClickHandler>(
    (items, index, modifiers) => {
      const item = items[index];
      if (!item) return;

      const intent = resolveListSelection(anchorRef.current, index, items.length, modifiers);
      switch (intent.kind) {
        case 'range':
          // Keep the anchor so further shift-clicks re-anchor from it.
          selectExact(items.slice(intent.lo, intent.hi + 1));
          return;
        case 'toggle':
          toggleSelection(item.globalId);
          toggleEntitySelection({ modelId: item.modelId, expressId: item.expressId });
          anchorRef.current = index;
          return;
        case 'single':
          selectExact([item]);
          anchorRef.current = index;
          return;
      }
    },
    [selectExact, toggleSelection, toggleEntitySelection],
  );

  return { select, setAnchor };
}
