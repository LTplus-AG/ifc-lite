/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section a basket view remembers (#7545): every plane that is cutting on screen, in the order
 * the planes were made, and which of them was active. `null` when nothing is cutting. Restoring it
 * is `basketViewActivator`'s `installSectionPlanes`, which replaces the whole set.
 */

import type { SectionPlane } from '../types.js';
import type { SceneVisibilityState } from './sceneStateSlice.js';
import { activeSectionPlane, clippingSectionPlanes } from '../section-active.js';
import { orderedSectionPlanes } from '../../lib/section/section-plane-set.js';
import type { BasketSectionSnapshot } from './pinboardSlice.js';

interface SectionSnapshotState {
  sectionPlane: SectionPlane;
  inactiveSectionPlanes?: SectionPlane[];
  sceneState: SceneVisibilityState;
  drawing2DDisplayOptions: { show3DOverlay: boolean; showHiddenLines: boolean };
}

export function captureSectionSnapshot(state: SectionSnapshotState): BasketSectionSnapshot | null {
  // The active plane leads when it is cutting, else the first that is.
  const cutting = clippingSectionPlanes(state);
  const plane = activeSectionPlane(state) ?? cutting[0];
  if (!plane) return null;
  const ordered = orderedSectionPlanes(state.sectionPlane, state.inactiveSectionPlanes ?? []).filter((p) => cutting.includes(p));

  return {
    plane: { ...plane },
    ...(ordered.length > 1 ? { planes: ordered.map((p) => ({ ...p })), activeIndex: ordered.indexOf(plane) } : {}),
    // Basket views restore 3D section state only. 2D drawings are derived, mutable,
    // and global in store state; persisting them per-view causes cross-view leakage.
    drawing2D: null,
    show3DOverlay: state.drawing2DDisplayOptions.show3DOverlay,
    showHiddenLines: state.drawing2DDisplayOptions.showHiddenLines,
  };
}
