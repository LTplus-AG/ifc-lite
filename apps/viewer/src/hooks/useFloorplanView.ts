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

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from './useIfc';
import {
  collectStoreys,
  mergedSectionBounds,
  sectionAxisRange,
  storeyCutElevation,
  worldToPercent,
  type SectionStorey,
} from '@/lib/section/section-distance';

export function useFloorplanView() {
  const { models, ifcDataStore, geometryResult } = useIfc();
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const openPanelInHome = useViewerStore((s) => s.openPanelInHome);

  // Every storey, deduplicated and sorted top-down — the same list the
  // Section bar's storey menu offers (#5499), from the one collector.
  const availableStoreys = useMemo(
    (): SectionStorey[] => collectStoreys(models, ifcDataStore),
    [models, ifcDataStore],
  );

  // Activate a floorplan view at the given storey elevation
  const activateFloorplan = useCallback((storey: SectionStorey) => {
    // The plan cut sits 1.2 m above the floor (standard architectural
    // practice), expressed as a percentage of the merged Y bounds — the
    // same conversion the Section bar's distance field uses.
    const range = sectionAxisRange(mergedSectionBounds(models, geometryResult), 'down');
    // Fallback bounds if no coordinate info available
    const percentage = range ? worldToPercent(storeyCutElevation(storey), range) : 50;

    // 2. Set section plane: axis=down (Y), position=calculated, enabled
    setSectionPlaneAxis('down');
    setSectionPlanePosition(percentage);
    setActiveTool('section', 'programmatic');

    // 3. Show the cut: dock the Drawing panel (no forced 3D camera change —
    // "Match 3D" in its header does that on request, #5497).
    openPanelInHome('drawing', 'programmatic');
  }, [models, geometryResult, setSectionPlaneAxis, setSectionPlanePosition, setActiveTool, openPanelInHome]);

  return { availableStoreys, activateFloorplan };
}
