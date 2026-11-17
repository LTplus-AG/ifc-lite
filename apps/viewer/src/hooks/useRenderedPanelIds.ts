/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panels drawn on screen right now (`renderedPanelIds`), from the live
 * store: the inputs `SidebarDock`, `SidebarPanelHost` and `ViewerLayout` draw
 * from. The activity rail pins exactly these (#8802 R6 review).
 */

import { useMemo, useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import { renderedPanelIds } from '@/lib/panels/rendered-panels';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { useEmptyStartFold, useEmptyStartFoldsSidebarPane } from '@/components/viewer/welcome/useEmptyStartFold';
import {
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { useBottomPanelFlags } from './useBottomPanelFlags';

export function useRenderedPanelIds(): ReadonlySet<WorkspacePanelId> {
  const sidebarMode = useViewerStore((s) => s.sidebarMode);
  const activePanel = useViewerStore((s) => s.sidebarActivePanel);
  const secondaryPanel = useViewerStore((s) => s.sidebarSecondaryPanel);
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  const poppedOutIds = useViewerStore((s) => s.poppedOutIds);
  const bottomFlags = useBottomPanelFlags();
  const hierarchyFolded = useEmptyStartFold();
  const paneFoldedForStart = useEmptyStartFoldsSidebarPane();
  // `SidebarPanelHost` gives the whole pane to a right-placed analysis extension.
  const analysis = useSyncExternalStore(subscribeAnalysisExtensions, getAnalysisExtensionsSnapshot, getAnalysisExtensionsSnapshot);
  const extension = getAnalysisExtensionById(analysis.activeId);
  const rightExtensionActive = !!extension && (extension.placement ?? 'right') === 'right';

  return useMemo(() => renderedPanelIds({
    sidebarMode,
    paneFoldedForStart,
    rightExtensionActive,
    activePanel,
    secondaryPanel,
    leftSlotOpen: !leftPanelCollapsed && !hierarchyFolded,
    bottomFlags,
    floatingIds: new Set(floatingPanels.map((p) => p.id)),
    poppedIds: new Set(poppedOutIds),
  }), [sidebarMode, paneFoldedForStart, rightExtensionActive, activePanel, secondaryPanel, leftPanelCollapsed, hierarchyFolded, bottomFlags, floatingPanels, poppedOutIds]);
}
