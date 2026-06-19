/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates the three places a workspace panel can live — the docked
 * sidebar, an in-app floating window (#1201) and a torn-off OS / PiP window
 * (#1208) — so the activity bar, the floating host, the window host, the
 * keyboard shortcuts and the command palette all open / float / pop-out /
 * close / re-dock panels identically.
 *
 * A panel is in exactly one of: `docked` (the single active sidebar panel),
 * `floating`, `popped` (OS window) or `closed`. The docked slot is driven by
 * the per-panel visibility flags, kept single-tenant by the store
 * subscription and surfaced as `sidebarActivePanel`.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { isAnalysisPanel, type WorkspacePanelId, type AnalysisPanelId } from '@/lib/panels/registry';
import { openPanelWindow, closePanelWindow } from '@/services/panel-windows';

export type PanelLocation = 'docked' | 'floating' | 'popped' | 'closed';

export interface PanelControls {
  /** Ids currently in an in-app floating window. */
  floatingIds: Set<WorkspacePanelId>;
  /** Ids currently torn off into an OS / PiP window. */
  poppedIds: Set<WorkspacePanelId>;
  /** The panel that owns the docked sidebar slot right now. */
  activePanel: WorkspacePanelId;
  /** Is the panel visible anywhere (docked / floating / popped)? */
  isOpen: (id: WorkspacePanelId) => boolean;
  /** Where the panel currently lives. */
  panelLocation: (id: WorkspacePanelId) => PanelLocation;
  /** Open the panel docked in the sidebar (re-docks it if detached). */
  openDocked: (id: WorkspacePanelId) => void;
  /** Toggle a panel's docked visibility (second activation closes it). */
  toggleDocked: (id: WorkspacePanelId) => void;
  /** Pop the panel into an in-app floating window. */
  floatPanel: (id: WorkspacePanelId) => void;
  /** Tear the panel off into an OS / PiP window (another screen / tab). */
  popOutPanel: (id: WorkspacePanelId) => void;
  /** Fully close a panel (stop floating, close its window, clear docked). */
  closePanel: (id: WorkspacePanelId) => void;
  /** Re-dock a detached panel into the sidebar. */
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
  const poppedOutIds = useViewerStore((s) => s.poppedOutIds);
  const activePanel = useViewerStore((s) => s.sidebarActivePanel);

  const floatingIds = useMemo(
    () => new Set<WorkspacePanelId>(floatingPanels.map((p) => p.id)),
    [floatingPanels],
  );
  const poppedIds = useMemo(() => new Set<WorkspacePanelId>(poppedOutIds), [poppedOutIds]);

  const isOpen = useCallback(
    (id: WorkspacePanelId): boolean => floatingIds.has(id) || poppedIds.has(id) || activePanel === id,
    [floatingIds, poppedIds, activePanel],
  );

  const panelLocation = useCallback(
    (id: WorkspacePanelId): PanelLocation => {
      if (floatingIds.has(id)) return 'floating';
      if (poppedIds.has(id)) return 'popped';
      if (activePanel === id) return 'docked';
      return 'closed';
    },
    [floatingIds, poppedIds, activePanel],
  );

  const openDocked = useCallback((id: WorkspacePanelId) => {
    useViewerStore.getState().showWorkspacePanel(id);
  }, []);

  const toggleDocked = useCallback((id: WorkspacePanelId) => {
    useViewerStore.getState().toggleWorkspacePanel(id);
  }, []);

  const floatPanel = useCallback((id: WorkspacePanelId) => {
    // Leave the docked flag alone — the sidebar host guards on `floatingIds`,
    // so the panel just moves from the slot to the floating window. Close any
    // OS window first so a panel is never floating AND popped at once.
    closePanelWindow(id);
    useViewerStore.getState().floatPanel(id);
    useViewerStore.getState().setRightPanelCollapsed(false);
  }, []);

  const popOutPanel = useCallback((id: WorkspacePanelId) => {
    // Must run synchronously in the click handler to keep the user-activation
    // that `documentPictureInPicture.requestWindow` / `window.open` require.
    void openPanelWindow(id);
  }, []);

  const closePanel = useCallback((id: WorkspacePanelId) => {
    useViewerStore.getState().closeFloatingPanel(id);
    closePanelWindow(id);
    if (isAnalysisPanel(id)) setDockedVisible(id, false);
  }, []);

  const dockPanel = useCallback((id: WorkspacePanelId) => openDocked(id), [openDocked]);

  return {
    floatingIds,
    poppedIds,
    activePanel,
    isOpen,
    panelLocation,
    openDocked,
    toggleDocked,
    floatPanel,
    popOutPanel,
    closePanel,
    dockPanel,
  };
}
