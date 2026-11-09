/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useViewerStore } from '@/store';

/** Reserve plan + the measured 3D HUD minimum at 1600px beside Defaults (#9296). */
export function useModelHierarchyWidth(ref: RefObject<PanelImperativeHandle | null>, folded: boolean, defaultWidth: number): boolean {
  const modeling = useViewerStore((s) => s.workspaceMode === 'model');
  const collapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const resetEpoch = useViewerStore((s) => s.layoutResetEpoch);
  const appliedReset = useRef(0);
  const restore = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const panel = ref.current;
    const reset = resetEpoch !== appliedReset.current;
    appliedReset.current = resetEpoch;
    if (reset) {
      // Reset supersedes both a live session snapshot and a deferred restore.
      restore.current = null;
      pending.current = defaultWidth;
    }
    if (!modeling) {
      const width = restore.current ?? pending.current;
      restore.current = null;
      if (width !== null) {
        // Restore on the next expansion without opening a collapsed panel.
        pending.current = width;
        if (panel && !panel.isCollapsed()) {
          panel.resize(`${width}%`);
          pending.current = null;
        }
      }
      return;
    }
    if (!panel || collapsed || folded || panel.isCollapsed()) return;
    const width = panel.getSize().asPercentage;
    restore.current ??= pending.current ?? (Number.isFinite(width) && width > 0 ? width : defaultWidth);
    pending.current = null;
    if (reset || !Number.isFinite(width) || width > 18) panel.resize(`${reset ? Math.min(defaultWidth, 18) : 18}%`);
  }, [modeling, collapsed, folded, defaultWidth, ref, resetEpoch]);
  return modeling;
}
