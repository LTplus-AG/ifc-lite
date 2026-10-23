/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '../index.js';

const DEFAULT_TRANSITION_MS = 700;

/**
 * Coordinator for activating a saved basket view.
 * Owns camera + section + drawing side effects; delegates entity/isolation to pinboard.
 */
export function activateBasketViewFromStore(viewId: string): void {
  const state = useViewerStore.getState();
  const view = state.basketViews.find((v) => v.id === viewId);
  if (!view) return;

  // Basket activation must never restore or keep 2D profile overlays.
  // Basket views should only affect 3D model geometry visibility/sectioning.
  state.setDrawing2D(null);
  state.setDrawing2DPanelVisible(false);
  state.updateDrawing2DDisplayOptions({ show3DOverlay: false });

  state.clearEntitySelection();
  state.restoreBasketEntities(view.entityRefs, viewId);

  if (view.viewpoint) {
    const transitionMs = view.transitionMs ?? DEFAULT_TRANSITION_MS;
    state.cameraCallbacks.applyViewpoint?.(view.viewpoint, true, transitionMs);
  }

  if (view.section) {
    const sectionSnapshot = view.section;
    // The snapshot replaces the whole set (#7545), in the order the planes were made.
    state.installSectionPlanes(sectionSnapshot.planes ?? [sectionSnapshot.plane], sectionSnapshot.activeIndex ?? 0);
    useViewerStore.setState({
      // The snapshot was only ever captured while ON SCREEN (`activeSectionPlane`
      // in `captureSectionSnapshot`), so restoring it puts it on screen too,
      // independent of which tool is active (#5893).
      sceneState: { ...state.sceneState, section: { visible: true } },
      drawing2DPanelVisible: false,
    });
    if (sectionSnapshot.plane.enabled) {
      state.setActiveTool('section', 'programmatic');
    } else if (state.activeTool === 'section') {
      state.setActiveTool('select', 'programmatic');
    }
  } else {
    // This view has no section snapshot: ensure previously active cutting is cleared.
    const current = useViewerStore.getState();
    const off = <T extends { enabled: boolean; parked?: boolean }>(plane: T): T => ({ ...plane, enabled: false, parked: false }); // parked too (#4910)
    useViewerStore.setState({
      // Every plane, not only the active one: a view without a cut must not keep a second plane cutting (#7545).
      sectionPlane: off(current.sectionPlane),
      inactiveSectionPlanes: current.inactiveSectionPlanes.map(off),
      sceneState: { ...state.sceneState, section: { visible: true } }, // next cut starts visible (#5893)
    });
    if (state.activeTool === 'section') {
      state.setActiveTool('select', 'programmatic');
    }
  }
}
