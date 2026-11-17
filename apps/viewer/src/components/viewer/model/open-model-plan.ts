/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore, type ViewerState } from '@/store';
import { getSplitWidth, splitFits } from './model-layout';

/**
 * Whether the plan can be shown: the split fits, or an expanded sidebar can
 * fold to make room, which `setModelLayout` does, as from the rail (#9296).
 */
export function canOpenModelPlan(s: Pick<ViewerState, 'sidebarMode'> = useViewerStore.getState()): boolean {
  return splitFits(getSplitWidth()) || s.sidebarMode === 'expanded';
}

/** Same layout action as the rail; reveal instead of toggling a visible plan away. */
export function openModelPlan(): boolean {
  if (!canOpenModelPlan()) return false;
  const s = useViewerStore.getState();
  if (s.workspaceMode !== 'model' && !s.enterModelWorkspace()) return false;
  useViewerStore.getState().setModelLayout('split');
  return true;
}
