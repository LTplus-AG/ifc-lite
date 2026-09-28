/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Add Element panel's wall type is drawn by the `wall.place` modeling
 * command (charter #6232, WP2), not by the add-element click handler. The
 * panel stays open while that command runs (it owns the wall's thickness and
 * height), and picking another type hands the canvas back to the
 * add-element tool.
 */

import { useEffect } from 'react';
import { useViewerStore, type ViewerState } from '@/store';

const WALL_PLACE = 'wall.place';

/**
 * The Add Element panel is open: its own tool, or its wall type's command.
 * A wall started from the Model workspace (rail, W, palette) is not the
 * panel's and leaves the sidebar alone.
 */
export function selectAddElementPanelOpen(s: ViewerState): boolean {
  return s.activeTool === 'addElement' || (s.addElementDrawsWall && s.session?.activeCommandId === WALL_PLACE);
}

/** Keep the canvas tool in step with the panel's element type. */
export function useWallPlaceBridge(): void {
  const addElementType = useViewerStore((s) => s.addElementType);
  const activeTool = useViewerStore((s) => s.activeTool);
  const placingWalls = useViewerStore((s) => s.addElementDrawsWall && s.session?.activeCommandId === WALL_PLACE);
  useEffect(() => {
    const s = useViewerStore.getState();
    if (addElementType === 'wall' && activeTool === 'addElement') {
      s.setAddElementDrawsWall(true);
      s.startCommand(WALL_PLACE);
    }
    else if (addElementType !== 'wall' && placingWalls) s.setActiveTool('addElement');
  }, [addElementType, activeTool, placingWalls]);

  // The panel's model / storey pickers move the session the walls land on.
  const modelId = useViewerStore((s) => s.addElementModelId);
  const storeyId = useViewerStore((s) => s.addElementStoreyId);
  useEffect(() => {
    const s = useViewerStore.getState();
    if (!placingWalls || !s.session) return;
    if (modelId !== null && modelId !== s.session.modelId) {
      s.exitModelWorkspace();
      s.startCommand(WALL_PLACE);
    } else if (storeyId !== null && storeyId !== s.session.storeyId) {
      s.setSessionStorey(storeyId);
    }
  }, [modelId, storeyId, placingWalls]);
}
