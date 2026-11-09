/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useViewerStore } from '@/store';

/** Reserve plan + the measured 3D HUD minimum at 1600px beside Defaults (#9296). */
export function useModelHierarchyWidth(ref: RefObject<PanelImperativeHandle | null>): boolean {
  const modeling = useViewerStore((s) => s.workspaceMode === 'model');
  const restore = useRef<number | null>(null);
  useEffect(() => {
    const panel = ref.current;
    if (!panel || panel.isCollapsed()) return;
    if (modeling) {
      restore.current ??= panel.getSize().asPercentage;
      if (restore.current > 18) panel.resize('18%');
    } else if (restore.current !== null) {
      panel.resize(`${restore.current}%`);
      restore.current = null;
    }
  }, [modeling, ref]);
  return modeling;
}
