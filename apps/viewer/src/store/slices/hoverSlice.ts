/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hover and context menu state slice
 */

import type { StateCreator } from 'zustand';
import type { HoverState, ContextMenuState } from '../types.js';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * "Nothing is hovered", in one place.
 *
 * The initial state, {@link HoverSlice.clearHover} and the session-reset
 * teardown all wrote this same four-field literal by hand; three copies of a
 * value is three chances for them to disagree about what "cleared" means.
 * `worldPosition` is left unset, exactly as all three did.
 */
function emptyHoverState(): HoverState {
  return { entityId: null, screenX: 0, screenY: 0 };
}

/** "The context menu is closed", likewise shared by the initial state,
 *  {@link HoverSlice.closeContextMenu} and the teardown. */
function closedContextMenu(): ContextMenuState {
  return { isOpen: false, entityId: null, screenX: 0, screenY: 0 };
}

export interface HoverSlice {
  // State
  hoverState: HoverState;
  contextMenu: ContextMenuState;

  // Actions
  setHoverState: (state: HoverState) => void;
  clearHover: () => void;
  openContextMenu: (entityId: number | null, screenX: number, screenY: number) => void;
  closeContextMenu: () => void;
}

export const createHoverSlice: StateCreator<HoverSlice, [], [], HoverSlice> = (set) => ({
  // Initial state
  hoverState: emptyHoverState(),
  contextMenu: closedContextMenu(),

  // Actions
  setHoverState: (hoverState) => set({ hoverState }),
  clearHover: () => set({ hoverState: emptyHoverState() }),

  openContextMenu: (entityId, screenX, screenY) => set({
    contextMenu: { isOpen: true, entityId, screenX, screenY },
  }),

  closeContextMenu: () => set({ contextMenu: closedContextMenu() }),
});

/**
 * What a session reset clears on the hover slice.
 *
 * `resetViewerState`'s "Hover/Context" block (`store/index.ts`). Both fields
 * name an entity in the OUTGOING model by express id, and ids are reused
 * across files, so a hover tooltip or an open context menu surviving a swap
 * describes an unrelated element of the incoming one.
 *
 * `clearHover()` covers `hoverState` alone and stays a separate action: it is
 * the pointer-leave path, which must not close a context menu the user opened.
 * Both now build their value from the same helpers above, so the two paths
 * cannot drift.
 */
export const hoverTeardown = defineSliceTeardown('hoverSlice', ['hoverState', 'contextMenu'], {
  'session-reset': () => ({
    hoverState: emptyHoverState(),
    contextMenu: closedContextMenu(),
  }),
  'model-removed': notApplicable,
  'all-models-cleared': notApplicable,
});
