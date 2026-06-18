/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates the docked right slot with the floating-panel channel
 * (issues #1200 / #1201) so the switcher, the floating host and the keyboard
 * shortcuts all open / float / close / dock panels identically.
 *
 * Two orthogonal pieces of state:
 *  - per-panel visibility flags (the existing mutually-exclusive right slot),
 *  - the dock slice's floating set.
 * The right slot in `ViewerLayout` renders a panel only when it is visible AND
 * not floating, so "open" really means "floating OR docked-visible".
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { isAnalysisPanel, type WorkspacePanelId, type AnalysisPanelId } from '@/lib/panels/registry';

export interface PanelControls {
  /** Ids currently floating. */
  floatingIds: Set<WorkspacePanelId>;
  /** Is the panel open at all (floating or docked-visible)? */
  isOpen: (id: WorkspacePanelId) => boolean;
  /** Open the panel docked in the right slot (un-floats it if floating). */
  openDocked: (id: WorkspacePanelId) => void;
  /** Toggle a panel's docked visibility. */
  toggleDocked: (id: WorkspacePanelId) => void;
  /** Pop a panel out into a floating window. */
  floatPanel: (id: WorkspacePanelId) => void;
  /** Fully close a panel (stop floating + clear docked visibility). */
  closePanel: (id: WorkspacePanelId) => void;
  /** Re-dock a floating panel into the right slot. */
  dockPanel: (id: WorkspacePanelId) => void;
}

function setDockedVisible(id: AnalysisPanelId, visible: boolean): void {
  const s = useViewerStore.getState();
  switch (id) {
    case 'compare': s.setComparePanelVisible(visible); break;
    case 'bcf': s.setBcfPanelVisible(visible); break;
    case 'ids': s.setIdsPanelVisible(visible); break;
    case 'lens': s.setLensPanelVisible(visible); break;
    case 'clash': s.setClashPanelVisible(visible); break;
    case 'extensions': s.setExtensionsPanelVisible(visible); break;
  }
}

export function usePanelControls(): PanelControls {
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  // Subscribe to the docked flags so `isOpen` highlights update live.
  const compareVisible = useViewerStore((s) => s.comparePanelVisible);
  const bcfVisible = useViewerStore((s) => s.bcfPanelVisible);
  const idsVisible = useViewerStore((s) => s.idsPanelVisible);
  const lensVisible = useViewerStore((s) => s.lensPanelVisible);
  const clashVisible = useViewerStore((s) => s.clashPanelVisible);
  const extensionsVisible = useViewerStore((s) => s.extensionsPanelVisible);

  const floatingIds = useMemo(
    () => new Set<WorkspacePanelId>(floatingPanels.map((p) => p.id)),
    [floatingPanels],
  );

  const dockedVisible = useMemo<Record<AnalysisPanelId, boolean>>(
    () => ({
      compare: compareVisible,
      bcf: bcfVisible,
      ids: idsVisible,
      lens: lensVisible,
      clash: clashVisible,
      extensions: extensionsVisible,
    }),
    [compareVisible, bcfVisible, idsVisible, lensVisible, clashVisible, extensionsVisible],
  );

  const anyAnalysisDocked = Object.entries(dockedVisible).some(
    ([id, v]) => v && !floatingIds.has(id as AnalysisPanelId),
  );

  const isOpen = useCallback(
    (id: WorkspacePanelId): boolean => {
      if (floatingIds.has(id)) return true;
      if (id === 'properties') return !anyAnalysisDocked; // the fallback
      return dockedVisible[id];
    },
    [floatingIds, dockedVisible, anyAnalysisDocked],
  );

  const openDocked = useCallback((id: WorkspacePanelId) => {
    useViewerStore.getState().showWorkspacePanel(id);
  }, []);

  const toggleDocked = useCallback(
    (id: WorkspacePanelId) => {
      if (floatingIds.has(id)) {
        openDocked(id);
        return;
      }
      if (isAnalysisPanel(id) && dockedVisible[id]) {
        setDockedVisible(id, false);
        return;
      }
      openDocked(id);
    },
    [floatingIds, dockedVisible, openDocked],
  );

  const floatPanel = useCallback((id: WorkspacePanelId) => {
    // Leave the docked flag alone — the right slot guards on `floatingIds`, so
    // the panel simply moves from the slot to the floating window.
    useViewerStore.getState().floatPanel(id);
    useViewerStore.getState().setRightPanelCollapsed(false);
  }, []);

  const closePanel = useCallback((id: WorkspacePanelId) => {
    useViewerStore.getState().closeFloatingPanel(id);
    if (isAnalysisPanel(id)) setDockedVisible(id, false);
  }, []);

  const dockPanel = useCallback((id: WorkspacePanelId) => openDocked(id), [openDocked]);

  return { floatingIds, isOpen, openDocked, toggleDocked, floatPanel, closePanel, dockPanel };
}
