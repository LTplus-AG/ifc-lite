/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for automatic floorplan views per storey.
 *
 * Activates a plan-cut section plane at the storey's elevation and opens the
 * Drawing panel docked so the cut is visible immediately (#5497). It used to
 * also force the 3D viewport into orthographic top-down; that stopped being
 * automatic — the Drawing header's "Match 3D" button applies it on request
 * instead, so switching storeys no longer yanks the 3D camera out from under
 * a user who was mid-orbit.
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import { usePlacedSectionStoreys } from './usePlacementCoordinateInfo';
import {
  sectionAxisRange,
  storeyCutPosition,
  type SectionStorey,
} from '@/lib/section/section-distance';

export function useFloorplanView() {
  const { placed, storeys: availableStoreys } = usePlacedSectionStoreys();
  // Activate a floorplan view at the given storey elevation
  const activateFloorplan = useCallback((storey: SectionStorey) => {
    const { setSectionPlaneAxis, setSectionPlanePosition, setActiveTool, openPanelInHome } = useViewerStore.getState();
    // The plan cut sits 1.2 m above the floor (standard architectural
    // practice), expressed as a percentage of the merged Y bounds — the
    // same helper the Section bar's storey menu uses. Above the model top
    // it stays at floor + 1.2 m (past 100 %) when the floor is in range (#8162).
    const range = sectionAxisRange(placed?.shiftedBounds ?? null, 'down');
    // Fallback bounds if no coordinate info available
    const percentage = range ? storeyCutPosition(storey, range) : 50;

    // 2. Set section plane: axis=down (Y), position=calculated, enabled
    setSectionPlaneAxis('down');
    setSectionPlanePosition(percentage);
    setActiveTool('section', 'programmatic');

    // 3. Show the cut: dock the Drawing panel (no forced 3D camera change —
    // "Match 3D" in its header does that on request, #5497).
    openPanelInHome('drawing', 'programmatic');
  }, [placed]);

  return { availableStoreys, activateFloorplan };
}
