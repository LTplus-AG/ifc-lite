/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreApi } from 'zustand';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import type { ViewerState } from './index.js';

/** Docked sidebar flags; properties is the fallback when none is on. */
export const SIDEBAR_PANEL_FLAGS: ReadonlyArray<readonly [keyof ViewerState, WorkspacePanelId]> = [
  ['bcfPanelVisible', 'bcf'],
  ['idsPanelVisible', 'validation'],
  ['lensPanelVisible', 'lens'],
  ['clashPanelVisible', 'clash'],
  ['comparePanelVisible', 'compare'],
  ['extensionsPanelVisible', 'extensions'],
  ['sourcesPanelVisible', 'sources'],
  ['collabPanelVisible', 'collab'],
  ['layersPanelVisible', 'layers'],
];

/** Keep the unified sidebar to one docked panel when flags change (#1208). */
export function registerSidebarExclusivity(store: StoreApi<ViewerState>): void {
  store.subscribe((state, prev) => {
    let opened: WorkspacePanelId | null = null;
    for (const [flag, id] of SIDEBAR_PANEL_FLAGS) {
      if (state[flag] && !prev[flag]) { opened = id; break; }
    }

    if (opened) {
      const patch: Record<string, boolean> = {};
      for (const [flag, id] of SIDEBAR_PANEL_FLAGS) {
        if (id !== opened && state[flag]) patch[flag] = false;
      }
      if (Object.keys(patch).length > 0) store.setState(patch as Partial<ViewerState>);
      state.setSidebarActivePanel(opened);
      if (state.sidebarMode !== 'expanded') state.setSidebarMode('expanded');
      return;
    }

    const active = state.sidebarActivePanel;
    if (active !== 'properties') {
      const flag = SIDEBAR_PANEL_FLAGS.find(([, id]) => id === active)?.[0];
      if (flag && !state[flag] && prev[flag]) {
        const next = SIDEBAR_PANEL_FLAGS.find(([f]) => state[f]);
        state.setSidebarActivePanel(next ? next[1] : 'properties');
      }
    }
  });
}

/** Hiding the Hierarchy rail entry also collapses its left slot (#1267). */
export function registerHierarchyLeftSync(store: StoreApi<ViewerState>): void {
  store.subscribe((state, prev) => {
    const wasHidden = prev.sidebarHiddenIds.includes('hierarchy');
    const isHidden = state.sidebarHiddenIds.includes('hierarchy');
    if (isHidden !== wasHidden) state.setLeftPanelCollapsed(isHidden);
  });
}

/** Mirror the Drawing inspector's Sheet tab to legacy sheet visibility (#5495). */
export function registerDrawingInspectorSheetSync(store: StoreApi<ViewerState>): void {
  store.subscribe((state, prev) => {
    if (state.drawingInspectorTab !== prev.drawingInspectorTab) {
      const shouldBeVisible = state.drawingInspectorTab === 'sheet';
      if (state.sheetPanelVisible !== shouldBeVisible) store.setState({ sheetPanelVisible: shouldBeVisible });
      return;
    }
    if (prev.sheetPanelVisible && !state.sheetPanelVisible && state.drawingInspectorTab === 'sheet') {
      store.setState({ drawingInspectorTab: null });
    }
  });
}

/** Persisted flags existed before subscriptions were registered. */
export function reconcileInitialStoreSync(store: StoreApi<ViewerState>): void {
  const init = store.getState();
  const initialActive = SIDEBAR_PANEL_FLAGS.find(([flag]) => init[flag])?.[1];
  if (initialActive) init.setSidebarActivePanel(initialActive);
  if (init.sidebarHiddenIds.includes('hierarchy')) init.setLeftPanelCollapsed(true);
  if (init.drawingInspectorTab === 'sheet' && !init.sheetPanelVisible) store.setState({ sheetPanelVisible: true });
}
