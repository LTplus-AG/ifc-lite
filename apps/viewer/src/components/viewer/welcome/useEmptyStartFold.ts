/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether the start screen should have the viewer to itself: nothing loaded,
 * nothing loading. While it does, Hierarchy and the Properties pane — both of
 * which can only say "no model" — fold out of the way.
 *
 * The fold is PRESENTATION ONLY. It never writes `leftPanelCollapsed`,
 * `rightPanelCollapsed` or `sidebarMode`: tours snapshot those, the assistant
 * reads them to place panels, and the user's own choice must be exactly what
 * comes back when a model loads. Callers apply the fold on top of the stored
 * state and stop applying it the moment these return false.
 */

import { useViewerStore } from '@/store';
import { hasLoadedModel } from '@/store/slices/uiSlice.helpers';

type FoldState = Parameters<typeof hasLoadedModel>[0] & {
  loading: boolean;
  sidebarActivePanel: string;
  sidebarSecondaryPanel: string | null;
};

/** True while no model is loaded or loading. */
export function isEmptyStart(s: FoldState): boolean {
  return !s.loading && !hasLoadedModel(s);
}

/**
 * True while the right sidebar's content pane should fold for the start
 * screen: only when it would show nothing but the default Properties panel.
 * Opening any other panel (Cloud Sources from the welcome card, the
 * assistant, a split) shows the pane again immediately.
 */
export function startFoldsSidebarPane(s: FoldState): boolean {
  return isEmptyStart(s) && s.sidebarActivePanel === 'properties' && s.sidebarSecondaryPanel === null;
}

export function useEmptyStartFold(): boolean {
  return useViewerStore(isEmptyStart);
}

export function useEmptyStartFoldsSidebarPane(): boolean {
  return useViewerStore(startFoldsSidebarPane);
}
