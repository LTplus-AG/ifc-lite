/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Hide selection": the one implementation every surface calls (#5852).
 *
 * The keyboard, the ribbon, the classic toolbar, the palette, the mobile
 * toolbar and the context menu each used to hide in their own way: some kept
 * the (now invisible) selection, one hid only the primary entity, one hid only
 * the right-clicked entity. The rule here is the single answer:
 *
 *  - every selected entity is hidden (the multi-selection, else the scalar
 *    primary `selectedEntityId`);
 *  - the selection is then cleared on both channels, so a hidden entity is
 *    never what Properties shows or what the next key acts on.
 *
 * Not a Hide-selection surface, so deliberately not routed here: the model
 * tree's per-node eye toggle (`HierarchyPanel.handleVisibilityToggle`) hides or
 * shows one tree node's elements, whatever is selected.
 *
 * P2 (#5611) will change what "hidden" is stored as; this module is the call
 * site it updates.
 */

import { useViewerStore } from './index.js';

/** Global ids of the current selection: the multi-selection, else the primary. */
export function selectedGlobalIdsFromStore(): number[] {
  const { selectedEntityIds, selectedEntityId } = useViewerStore.getState();
  if (selectedEntityIds.size > 0) return Array.from(selectedEntityIds);
  return selectedEntityId !== null ? [selectedEntityId] : [];
}

/** Hide every selected entity, then clear the selection. Returns false when nothing was selected. */
export function hideSelectionFromStore(): boolean {
  const ids = selectedGlobalIdsFromStore();
  if (ids.length === 0) return false;
  const state = useViewerStore.getState();
  state.hideEntities(ids);
  state.clearEntitySelection();
  return true;
}

/**
 * The context menu's Hide, for the entity it was opened on. Right-clicking
 * inside the selection hides the whole selection (the file-manager
 * convention); right-clicking outside it hides just that entity and leaves the
 * selection alone.
 */
export function hideFromContextMenuFromStore(globalId: number): void {
  if (selectedGlobalIdsFromStore().includes(globalId)) {
    hideSelectionFromStore();
    return;
  }
  useViewerStore.getState().hideEntity(globalId);
}
