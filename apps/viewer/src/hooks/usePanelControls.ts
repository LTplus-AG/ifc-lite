/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates the places a workspace panel can live — its home dock (the right
 * pane for `side` panels, the bottom strip for `bottom` panels), an in-app
 * floating window (#1201) and a torn-off OS / PiP window (#1208) — so the
 * activity bar, the floating host, the window host, the keyboard shortcuts and
 * the command palette all open / float / pop-out / close / re-dock identically.
 *
 * A panel is in exactly one of: `docked` (shown in its home region),
 * `floating`, `popped` (OS window) or `closed`.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import {
  isAnalysisPanel,
  isBottomPanel,
  isLeftPanel,
  type WorkspacePanelId,
  type AnalysisPanelId,
} from '@/lib/panels/registry';
import { openPanelWindow, closePanelWindow } from '@/services/panel-windows';

export type PanelLocation = 'docked' | 'floating' | 'popped' | 'closed';

export interface PanelControls {
  floatingIds: Set<WorkspacePanelId>;
  poppedIds: Set<WorkspacePanelId>;
  /** The side panel that owns the right pane right now. */
  activePanel: WorkspacePanelId;
  isOpen: (id: WorkspacePanelId) => boolean;
  panelLocation: (id: WorkspacePanelId) => PanelLocation;
  /** Open a panel in its home region (right pane or bottom strip). */
  openInHome: (id: WorkspacePanelId) => void;
  /** Toggle a panel in its home region (second activation closes it). */
  toggle: (id: WorkspacePanelId) => void;
  /** Pop the panel into an in-app floating window. */
  floatPanel: (id: WorkspacePanelId) => void;
  /** Tear the panel off into an OS / PiP window (another screen). */
  popOutPanel: (id: WorkspacePanelId) => void;
  /** Fully close a panel (stop floating, close its window, clear its dock flag). */
  closePanel: (id: WorkspacePanelId) => void;
  /** Re-dock a detached panel into its home region. */
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
    case 'script': s.setScriptPanelVisible(visible); break;
    case 'gantt': s.setGanttPanelVisible(visible); break;
    case 'lists': s.setListPanelVisible(visible); break;
    case 'layers': s.setLayersPanelVisible(visible); break;
  }
}

export function usePanelControls(): PanelControls {
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  const poppedOutIds = useViewerStore((s) => s.poppedOutIds);
  const activePanel = useViewerStore((s) => s.sidebarActivePanel);
  // Bottom-strip visibility flags (their "docked" state).
  const scriptVisible = useViewerStore((s) => s.scriptPanelVisible);
  const ganttVisible = useViewerStore((s) => s.ganttPanelVisible);
  const listVisible = useViewerStore((s) => s.listPanelVisible);
  // The Hierarchy panel (left region, #1267) is "docked" while its slot is open.
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  // The lower half of a docked split (#1266), also docked/visible.
  const secondaryPanel = useViewerStore((s) => s.sidebarSecondaryPanel);

  const floatingIds = useMemo(
    () => new Set<WorkspacePanelId>(floatingPanels.map((p) => p.id)),
    [floatingPanels],
  );
  const poppedIds = useMemo(() => new Set<WorkspacePanelId>(poppedOutIds), [poppedOutIds]);

  // The side panel actually shown in the right pane — mirrors SidebarPanelHost:
  // the active panel, unless it's detached, in which case the pane falls back to
  // Information. Used so the rail highlights what is really on screen.
  const sideDocked = useMemo<WorkspacePanelId | null>(() => {
    if (!floatingIds.has(activePanel) && !poppedIds.has(activePanel)) return activePanel;
    if (!floatingIds.has('properties') && !poppedIds.has('properties')) return 'properties';
    return null;
  }, [activePanel, floatingIds, poppedIds]);

  // The panel actually rendered in the lower split half, mirroring
  // SidebarPanelHost's `secondaryActive`: set, inline (not floated / popped), and
  // distinct from the primary. So the rail reflects it as docked, not closed.
  const secondaryDocked = useMemo<WorkspacePanelId | null>(() => {
    if (!secondaryPanel || secondaryPanel === sideDocked) return null;
    if (floatingIds.has(secondaryPanel) || poppedIds.has(secondaryPanel)) return null;
    return secondaryPanel;
  }, [secondaryPanel, sideDocked, floatingIds, poppedIds]);

  const isDockedInHome = useCallback(
    (id: WorkspacePanelId): boolean => {
      if (id === 'hierarchy') return !leftPanelCollapsed; // left slot open
      if (id === 'script') return scriptVisible;
      if (id === 'gantt') return ganttVisible;
      if (id === 'lists') return listVisible;
      // A side panel is docked as the right-pane primary OR the split secondary.
      return id === sideDocked || id === secondaryDocked;
    },
    [sideDocked, secondaryDocked, scriptVisible, ganttVisible, listVisible, leftPanelCollapsed],
  );

  const panelLocation = useCallback(
    (id: WorkspacePanelId): PanelLocation => {
      if (floatingIds.has(id)) return 'floating';
      if (poppedIds.has(id)) return 'popped';
      return isDockedInHome(id) ? 'docked' : 'closed';
    },
    [floatingIds, poppedIds, isDockedInHome],
  );

  const isOpen = useCallback(
    (id: WorkspacePanelId): boolean => floatingIds.has(id) || poppedIds.has(id) || isDockedInHome(id),
    [floatingIds, poppedIds, isDockedInHome],
  );

  const openInHome = useCallback((id: WorkspacePanelId) => {
    // Hierarchy's home is the left slot, so reveal it instead of routing through
    // the right-pane / bottom-strip flags (#1267).
    if (isLeftPanel(id)) {
      useViewerStore.getState().setLeftPanelCollapsed(false);
      return;
    }
    useViewerStore.getState().openPanelInHome(id);
  }, []);

  const toggle = useCallback((id: WorkspacePanelId) => {
    if (isLeftPanel(id)) {
      const s = useViewerStore.getState();
      s.setLeftPanelCollapsed(!s.leftPanelCollapsed);
      return;
    }
    // If the panel is the lower split half it's already docked below, so
    // toggling its rail icon closes that half (clears the split) rather than
    // promoting it to primary and collapsing the split out from under it (#1266).
    if (useViewerStore.getState().sidebarSecondaryPanel === id) {
      useViewerStore.getState().setSidebarSecondaryPanel(null);
      return;
    }
    if (isBottomPanel(id)) useViewerStore.getState().toggleBottomPanel(id);
    else useViewerStore.getState().toggleWorkspacePanel(id);
  }, []);

  const floatPanel = useCallback((id: WorkspacePanelId) => {
    // The left nav panel stays docked on the left; it never floats (#1267).
    if (isLeftPanel(id)) {
      useViewerStore.getState().setLeftPanelCollapsed(false);
      return;
    }
    closePanelWindow(id);
    useViewerStore.getState().floatPanel(id);
    useViewerStore.getState().setRightPanelCollapsed(false);
  }, []);

  const popOutPanel = useCallback((id: WorkspacePanelId) => {
    if (isLeftPanel(id)) {
      useViewerStore.getState().setLeftPanelCollapsed(false);
      return;
    }
    void openPanelWindow(id);
  }, []);

  const closePanel = useCallback((id: WorkspacePanelId) => {
    if (isLeftPanel(id)) {
      useViewerStore.getState().setLeftPanelCollapsed(true);
      return;
    }
    // If it was the lower split half, leave the split too (#1266).
    if (useViewerStore.getState().sidebarSecondaryPanel === id) {
      useViewerStore.getState().setSidebarSecondaryPanel(null);
    }
    useViewerStore.getState().closeFloatingPanel(id);
    closePanelWindow(id);
    if (isAnalysisPanel(id)) setDockedVisible(id, false);
  }, []);

  const dockPanel = useCallback((id: WorkspacePanelId) => openInHome(id), [openInHome]);

  return {
    floatingIds,
    poppedIds,
    activePanel,
    isOpen,
    panelLocation,
    openInHome,
    toggle,
    floatPanel,
    popOutPanel,
    closePanel,
    dockPanel,
  };
}
