/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace-panel toggling shared by the classic toolbar's Panels menu
 * and the ribbon's Analyze / Author tabs. Encodes the single-tenant
 * right-slot and bottom-slot rules (one docked panel per region) plus
 * the analysis-extension handoff, exactly as the toolbar always did.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionsSnapshot,
  openAnalysisExtension,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { closePanelWindow } from '@/services/panel-windows';

/** Registry ids, deliberately. This hook used to spell the entity-list panel
 *  `'list'` while the registry and the store spell it `'lists'`, and the cost
 *  was structural rather than cosmetic: with ids that did not match, the bottom
 *  branch below could not simply hand the click to the store, so it re-derived
 *  the flag flips and lost the float / pop-out cleanup along the way. */
export type BottomPanel = 'script' | 'lists' | 'gantt';
export type RightPanel = 'bcf' | 'ids' | 'lens' | 'clash' | 'compare' | 'addElement' | 'extensions' | 'sources';
export type WorkspacePanel = BottomPanel | RightPanel | string;

export function useWorkspacePanelControls() {
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const bcfPanelVisible = useViewerStore((state) => state.bcfPanelVisible);
  const setBcfPanelVisible = useViewerStore((state) => state.setBcfPanelVisible);
  const idsPanelVisible = useViewerStore((state) => state.idsPanelVisible);
  const setIdsPanelVisible = useViewerStore((state) => state.setIdsPanelVisible);
  const clashPanelVisible = useViewerStore((state) => state.clashPanelVisible);
  const setClashPanelVisible = useViewerStore((state) => state.setClashPanelVisible);
  const comparePanelVisible = useViewerStore((state) => state.comparePanelVisible);
  const setComparePanelVisible = useViewerStore((state) => state.setComparePanelVisible);
  const listPanelVisible = useViewerStore((state) => state.listPanelVisible);
  const setListPanelVisible = useViewerStore((state) => state.setListPanelVisible);
  const lensPanelVisible = useViewerStore((state) => state.lensPanelVisible);
  const setLensPanelVisible = useViewerStore((state) => state.setLensPanelVisible);
  const extensionsPanelVisible = useViewerStore((state) => state.extensionsPanelVisible);
  const setExtensionsPanelVisible = useViewerStore((state) => state.setExtensionsPanelVisible);
  const sourcesPanelVisible = useViewerStore((state) => state.sourcesPanelVisible);
  const setSourcesPanelVisible = useViewerStore((state) => state.setSourcesPanelVisible);
  const scriptPanelVisible = useViewerStore((state) => state.scriptPanelVisible);
  const setScriptPanelVisible = useViewerStore((state) => state.setScriptPanelVisible);
  const ganttPanelVisible = useViewerStore((state) => state.ganttPanelVisible);
  const setGanttPanelVisible = useViewerStore((state) => state.setGanttPanelVisible);
  const layersPanelVisible = useViewerStore((state) => state.layersPanelVisible);
  const collabPanelVisible = useViewerStore((state) => state.collabPanelVisible);
  // The detached channels — a panel living in one of these is open regardless
  // of its dock flag (see `activeWorkspacePanels`).
  const floatingPanels = useViewerStore((state) => state.floatingPanels);
  const poppedOutIds = useViewerStore((state) => state.poppedOutIds);
  // Zones (#1810) has no dedicated visibility flag — it is a pure sidebar
  // panel, driven by `sidebarActivePanel`. Reading it HERE rather than in each
  // toolbar is what keeps the classic strip and the ribbon from drifting on
  // whether the Zones button looks active (#2508).
  const sidebarActivePanel = useViewerStore((state) => state.sidebarActivePanel);
  const setRightPanelCollapsed = useViewerStore((state) => state.setRightPanelCollapsed);

  const analysisExtensionState = useSyncExternalStore(
    subscribeAnalysisExtensions,
    getAnalysisExtensionsSnapshot,
    getAnalysisExtensionsSnapshot,
  );
  const activeAnalysisExtension = useMemo(
    () => analysisExtensionState.extensions.find((extension) => extension.id === analysisExtensionState.activeId) ?? null,
    [analysisExtensionState.activeId, analysisExtensionState.extensions],
  );
  const rightAnalysisExtensions = useMemo(
    () => analysisExtensionState.extensions.filter((extension) => (extension.placement ?? 'right') === 'right'),
    [analysisExtensionState.extensions],
  );
  const bottomAnalysisExtensions = useMemo(
    () => analysisExtensionState.extensions.filter((extension) => (extension.placement ?? 'right') === 'bottom'),
    [analysisExtensionState.extensions],
  );

  const handleToggleBottomPanel = useCallback((panel: BottomPanel) => {
    if (activeAnalysisExtension?.placement === 'bottom') {
      closeActiveAnalysisExtension();
    }
    // The store owns the bottom strip's re-dock rules, so hand it the click
    // rather than re-deriving the flag flips. The copy that used to live here
    // knew nothing about the float / pop-out channels: toggling a FLOATING
    // Lists panel cleared its dock flag and left the floating window on screen
    // with the toolbar latch off, while the same click from the activity bar
    // (which routes here) brought it home correctly.
    useViewerStore.getState().toggleBottomPanel(panel);
  }, [activeAnalysisExtension?.placement]);

  const handleToggleRightPanel = useCallback((panel: RightPanel) => {
    if (activeAnalysisExtension?.placement !== 'bottom') {
      closeActiveAnalysisExtension();
    }

    // "Active" means it owns the DOCKED slot right now, the same test the
    // store's `toggleWorkspacePanel` applies. A floating or popped-out panel
    // keeps its dock flag set, so negating the raw flag read the click as
    // "close" and the detach cleanup below then tore the panel down entirely —
    // where the rail, asking this question properly, brings it home. Toggling a
    // detached panel must re-dock it, never close it out from under its window.
    // `addElement` is a TOOL, not a registry panel, so it has no detach channel.
    const detached = panel !== 'addElement'
      && (floatingPanels.some((p) => p.id === panel) || poppedOutIds.includes(panel));
    const docked = (visible: boolean) => visible && !detached;

    const nextBcfVisible = panel === 'bcf' ? !docked(bcfPanelVisible) : false;
    const nextIdsVisible = panel === 'ids' ? !docked(idsPanelVisible) : false;
    const nextLensVisible = panel === 'lens' ? !docked(lensPanelVisible) : false;
    const nextClashVisible = panel === 'clash' ? !docked(clashPanelVisible) : false;
    const nextCompareVisible = panel === 'compare' ? !docked(comparePanelVisible) : false;
    const nextExtensionsVisible = panel === 'extensions' ? !docked(extensionsPanelVisible) : false;
    const nextSourcesVisible = panel === 'sources' ? !docked(sourcesPanelVisible) : false;
    const isAddElementActive = activeTool === 'addElement';
    const nextAddElementActive = panel === 'addElement' ? !isAddElementActive : false;

    setBcfPanelVisible(nextBcfVisible);
    setIdsPanelVisible(nextIdsVisible);
    setLensPanelVisible(nextLensVisible);
    setClashPanelVisible(nextClashVisible);
    setComparePanelVisible(nextCompareVisible);
    setExtensionsPanelVisible(nextExtensionsVisible);
    setSourcesPanelVisible(nextSourcesVisible);
    // Keep the float + window channels in sync (#1200/#1201/#1208): toggling a
    // workspace panel from the toolbar re-docks it if it was floating or popped
    // out, instead of leaving an orphaned floating panel or OS window.
    if (panel !== 'addElement') {
      useViewerStore.getState().closeFloatingPanel(panel);
      closePanelWindow(panel);
    }

    if (panel === 'addElement') {
      setActiveTool(nextAddElementActive ? 'addElement' : 'select');
    } else if (isAddElementActive) {
      setActiveTool('select');
    }

    if (nextBcfVisible || nextIdsVisible || nextLensVisible || nextClashVisible || nextCompareVisible || nextExtensionsVisible || nextSourcesVisible || nextAddElementActive) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    activeTool,
    bcfPanelVisible,
    clashPanelVisible,
    comparePanelVisible,
    extensionsPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    setActiveTool,
    setBcfPanelVisible,
    setClashPanelVisible,
    setComparePanelVisible,
    setExtensionsPanelVisible,
    setIdsPanelVisible,
    setLensPanelVisible,
    setRightPanelCollapsed,
    setSourcesPanelVisible,
    sourcesPanelVisible,
    floatingPanels,
    poppedOutIds,
  ]);

  const handleToggleAnalysisExtension = useCallback((id: string) => {
    const extension = analysisExtensionState.extensions.find((candidate) => candidate.id === id);
    if (!extension) {
      return;
    }

    if (analysisExtensionState.activeId === id) {
      closeActiveAnalysisExtension();
      return;
    }

    const opened = openAnalysisExtension(id);
    if (!opened) {
      return;
    }

    if ((extension.placement ?? 'right') === 'bottom') {
      setScriptPanelVisible(false);
      setListPanelVisible(false);
      setGanttPanelVisible(false);
      setRightPanelCollapsed(false);
      return;
    }

    setBcfPanelVisible(false);
    setIdsPanelVisible(false);
    setLensPanelVisible(false);
    setClashPanelVisible(false);
    setComparePanelVisible(false);
    setExtensionsPanelVisible(false);
    setSourcesPanelVisible(false);
    // The right slot is single-tenant: when an analysis extension takes
    // it over, the AddElement tool must release it too, otherwise its 3D
    // click handler keeps placing elements behind the extension panel.
    if (activeTool === 'addElement') {
      setActiveTool('select');
    }
    setRightPanelCollapsed(false);
  }, [
    activeTool,
    analysisExtensionState.activeId,
    analysisExtensionState.extensions,
    setActiveTool,
    setBcfPanelVisible,
    setClashPanelVisible,
    setComparePanelVisible,
    setExtensionsPanelVisible,
    setGanttPanelVisible,
    setIdsPanelVisible,
    setLensPanelVisible,
    setListPanelVisible,
    setRightPanelCollapsed,
    setScriptPanelVisible,
    setSourcesPanelVisible,
  ]);

  const activeWorkspacePanels = useMemo(() => {
    const panels = new Set<WorkspacePanel>();
    // A floating or popped-out panel is OPEN — the sidebar's single-tenant rule
    // clears its dock flag the moment another panel docks, without touching the
    // detached channels. Reading only the flags is what made a floating BCF
    // panel's latch go dark on both toolbars while the panel sat on screen; the
    // activity bar never had the bug because it reads `panelLocation`.
    for (const panel of floatingPanels) panels.add(panel.id);
    for (const id of poppedOutIds) panels.add(id);
    if (scriptPanelVisible) panels.add('script');
    if (listPanelVisible) panels.add('lists');
    if (ganttPanelVisible) panels.add('gantt');
    if (bcfPanelVisible) panels.add('bcf');
    if (idsPanelVisible) panels.add('ids');
    if (lensPanelVisible) panels.add('lens');
    if (clashPanelVisible) panels.add('clash');
    if (comparePanelVisible) panels.add('compare');
    if (extensionsPanelVisible) panels.add('extensions');
    if (sourcesPanelVisible) panels.add('sources');
    if (activeTool === 'addElement') panels.add('addElement');
    if (layersPanelVisible) panels.add('layers');
    if (collabPanelVisible) panels.add('collab');
    if (sidebarActivePanel === 'zones') panels.add('zones');
    if (analysisExtensionState.activeId) panels.add(analysisExtensionState.activeId);
    return panels;
  }, [
    activeTool,
    analysisExtensionState.activeId,
    bcfPanelVisible,
    collabPanelVisible,
    layersPanelVisible,
    clashPanelVisible,
    comparePanelVisible,
    extensionsPanelVisible,
    ganttPanelVisible,
    idsPanelVisible,
    lensPanelVisible,
    listPanelVisible,
    floatingPanels,
    poppedOutIds,
    scriptPanelVisible,
    sidebarActivePanel,
    sourcesPanelVisible,
  ]);

  const workspacePanelLabel = useMemo(() => {
    if (activeWorkspacePanels.size === 0) return null;
    if (activeWorkspacePanels.size > 1) return 'Multiple Panels';
    if (activeWorkspacePanels.has('script')) return 'Script Editor';
    if (activeWorkspacePanels.has('lists')) return 'Lists';
    if (activeWorkspacePanels.has('gantt')) return 'Schedule';
    if (activeWorkspacePanels.has('bcf')) return 'BCF Issues';
    if (activeWorkspacePanels.has('ids')) return 'IDS Validation';
    if (activeWorkspacePanels.has('lens')) return 'Lens Rules';
    if (activeWorkspacePanels.has('clash')) return 'Clash Detection';
    if (activeWorkspacePanels.has('compare')) return 'Compare Models';
    if (activeWorkspacePanels.has('extensions')) return 'Extensions';
    if (activeWorkspacePanels.has('sources')) return 'Cloud Sources';
    if (activeWorkspacePanels.has('addElement')) return 'Add Element';
    if (activeWorkspacePanels.has('layers')) return 'Layer Stack';
    if (activeWorkspacePanels.has('collab')) return 'Collaboration Room';
    if (activeWorkspacePanels.has('zones')) return 'Location Zones';
    return activeAnalysisExtension?.label ?? 'Analysis';
  }, [activeAnalysisExtension?.label, activeWorkspacePanels]);

  return {
    activeWorkspacePanels,
    workspacePanelLabel,
    handleToggleBottomPanel,
    handleToggleRightPanel,
    handleToggleAnalysisExtension,
    rightAnalysisExtensions,
    bottomAnalysisExtensions,
  };
}
