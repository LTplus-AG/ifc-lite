/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store never holds an unavailable panel open (see
 * `lib/panels/availability.ts`).
 *
 * Panels open through many doors: the panel actions, a dozen per-panel
 * visibility setters that other panels call directly, a persisted layout, a
 * layout preset, a deep link. Guarding each door would miss the next one, so
 * this is one invariant on the state instead: whatever turned an unavailable
 * panel on, it is off again before React renders.
 */

import type { StoreApi } from 'zustand';
import { isFeatureEnabled } from '../lib/features/index.js';
import { isPanelAvailable } from '../lib/panels/availability.js';
import { BOTTOM_PANEL_FLAG, BOTTOM_PANEL_IDS } from '../lib/panels/bottom-panels.js';
import { WORKSPACE_PANELS, type WorkspacePanelId } from '../lib/panels/registry.js';
import type { ViewerState } from './index.js';
import { SIDEBAR_PANEL_FLAGS } from './store-sync.js';

function patchFor(state: ViewerState, off: ReadonlySet<WorkspacePanelId>, chatOff: boolean): Partial<ViewerState> | null {
  const patch: Record<string, unknown> = {};
  for (const [flag, id] of SIDEBAR_PANEL_FLAGS) {
    if (state[flag] && off.has(id)) patch[flag] = false;
  }
  for (const id of BOTTOM_PANEL_IDS) {
    if (state[BOTTOM_PANEL_FLAG[id]] && off.has(id)) patch[BOTTOM_PANEL_FLAG[id]] = false;
  }
  if (off.has(state.sidebarActivePanel)) patch.sidebarActivePanel = 'properties';
  if (state.sidebarSecondaryPanel && off.has(state.sidebarSecondaryPanel)) patch.sidebarSecondaryPanel = null;
  if (state.floatingPanels.some((panel) => off.has(panel.id))) {
    patch.floatingPanels = state.floatingPanels.filter((panel) => !off.has(panel.id));
  }
  if (state.poppedOutIds.some((id) => off.has(id))) {
    // Dropping the id is what closes its OS window: panel-windows reconciles
    // its open windows against `poppedOutIds`.
    patch.poppedOutIds = state.poppedOutIds.filter((id) => !off.has(id));
  }
  if (chatOff && state.chatPanelVisible) patch.chatPanelVisible = false;
  return Object.keys(patch).length > 0 ? patch as Partial<ViewerState> : null;
}

/**
 * Close what is open and unavailable now (a persisted layout predates the
 * host's configuration) and keep it closed. Call once, after the feature set
 * is fixed: the set of unavailable panels is read here and never again. With
 * nothing switched off this subscribes to nothing. Returns the unsubscribe.
 */
export function enforcePanelAvailability(store: StoreApi<ViewerState>): () => void {
  const off: ReadonlySet<WorkspacePanelId> = new Set(WORKSPACE_PANELS.map((panel) => panel.id).filter((id) => !isPanelAvailable(id)));
  // The AI chat is a pane inside the Script panel, not a panel of its own.
  const chatOff = !isFeatureEnabled('ai.assistant');
  if (off.size === 0 && !chatOff) return () => {};
  const enforce = (state: ViewerState) => {
    const patch = patchFor(state, off, chatOff);
    if (patch) store.setState(patch);
  };
  enforce(store.getState());
  return store.subscribe(enforce);
}
