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
 *
 * An explicit panel action while folded (the Hierarchy toggle, a rail click,
 * a palette command) must not flip that stored state behind a pane the user
 * cannot see. It LIFTS the fold for that side instead (`liftStartFold`), for
 * the rest of this empty session; the lift resets once a model loads.
 */

import { useViewerStore } from '@/store';
import { hasLoadedModel } from '@/store/slices/uiSlice.helpers';

export type FoldSide = 'left' | 'right';

type FoldState = Parameters<typeof hasLoadedModel>[0] & {
  loading: boolean;
  sidebarActivePanel: string;
  sidebarSecondaryPanel: string | null;
  startFoldLifted: Record<FoldSide, boolean>;
};

/** True while no model is loaded or loading. */
export function isEmptyStart(s: FoldState): boolean {
  return !s.loading && !hasLoadedModel(s);
}

/** True while Hierarchy is folded for the start screen. */
export function startFoldsHierarchy(s: FoldState): boolean {
  return isEmptyStart(s) && !s.startFoldLifted.left;
}

/**
 * True while the right sidebar's content pane should fold for the start
 * screen: only when it would show nothing but the default Properties panel.
 * Opening any other panel (Cloud Sources from the welcome card, the
 * assistant, a split) shows the pane again immediately.
 */
export function startFoldsSidebarPane(s: FoldState): boolean {
  return isEmptyStart(s)
    && !s.startFoldLifted.right
    && s.sidebarActivePanel === 'properties'
    && s.sidebarSecondaryPanel === null;
}

/**
 * Lift the start-screen fold on one side if it is currently hiding that
 * side's panel. Returns true when it did, so a toggle can OPEN instead of
 * flipping stored state the user could not see.
 */
export function liftStartFold(side: FoldSide): boolean {
  const s = useViewerStore.getState();
  const folded = side === 'left' ? startFoldsHierarchy(s) : startFoldsSidebarPane(s);
  if (!folded) return false;
  s.setStartFoldLifted({ ...s.startFoldLifted, [side]: true });
  return true;
}

export function useEmptyStartFold(): boolean {
  return useViewerStore(startFoldsHierarchy);
}

export function useEmptyStartFoldsSidebarPane(): boolean {
  return useViewerStore(startFoldsSidebarPane);
}

/** Raw "nothing loaded or loading", for resetting the lifts. */
export function useIsEmptyStart(): boolean {
  return useViewerStore(isEmptyStart);
}
