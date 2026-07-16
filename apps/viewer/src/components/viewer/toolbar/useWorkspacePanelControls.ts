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

export type BottomPanel = 'script' | 'list' | 'gantt';
export type RightPanel = 'bcf' | 'ids' | 'lens' | 'clash' | 'compare' | 'addElement' | 'extensions';
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
  const scriptPanelVisible = useViewerStore((state) => state.scriptPanelVisible);
  const setScriptPanelVisible = useViewerStore((state) => state.setScriptPanelVisible);
  const ganttPanelVisible = useViewerStore((state) => state.ganttPanelVisible);
  const setGanttPanelVisible = useViewerStore((state) => state.setGanttPanelVisible);
  const layersPanelVisible = useViewerStore((state) => state.layersPanelVisible);
  const collabPanelVisible = useViewerStore((state) => state.collabPanelVisible);
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
    const nextScriptVisible = panel === 'script' ? !scriptPanelVisible : false;
    const nextListVisible = panel === 'list' ? !listPanelVisible : false;
    const nextGanttVisible = panel === 'gantt' ? !ganttPanelVisible : false;

    setScriptPanelVisible(nextScriptVisible);
    setListPanelVisible(nextListVisible);
    setGanttPanelVisible(nextGanttVisible);

    if (nextScriptVisible || nextListVisible || nextGanttVisible) {
      setRightPanelCollapsed(false);
    }
  }, [
    activeAnalysisExtension?.placement,
    ganttPanelVisible,
    listPanelVisible,
    scriptPanelVisible,
    setGanttPanelVisible,
    setListPanelVisible,
    setRightPanelCollapsed,
    setScriptPanelVisible,
  ]);

  const handleToggleRightPanel = useCallback((panel: RightPanel) => {
    if (activeAnalysisExtension?.placement !== 'bottom') {
      closeActiveAnalysisExtension();
    }

    const nextBcfVisible = panel === 'bcf' ? !bcfPanelVisible : false;
    const nextIdsVisible = panel === 'ids' ? !idsPanelVisible : false;
    const nextLensVisible = panel === 'lens' ? !lensPanelVisible : false;
    const nextClashVisible = panel === 'clash' ? !clashPanelVisible : false;
    const nextCompareVisible = panel === 'compare' ? !comparePanelVisible : false;
    const nextExtensionsVisible = panel === 'extensions' ? !extensionsPanelVisible : false;
    const isAddElementActive = activeTool === 'addElement';
    const nextAddElementActive = panel === 'addElement' ? !isAddElementActive : false;

    setBcfPanelVisible(nextBcfVisible);
    setIdsPanelVisible(nextIdsVisible);
    setLensPanelVisible(nextLensVisible);
    setClashPanelVisible(nextClashVisible);
    setComparePanelVisible(nextCompareVisible);
    setExtensionsPanelVisible(nextExtensionsVisible);
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

    if (nextBcfVisible || nextIdsVisible || nextLensVisible || nextClashVisible || nextCompareVisible || nextExtensionsVisible || nextAddElementActive) {
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
  ]);

  const activeWorkspacePanels = useMemo(() => {
    const panels = new Set<WorkspacePanel>();
    if (scriptPanelVisible) panels.add('script');
    if (listPanelVisible) panels.add('list');
    if (ganttPanelVisible) panels.add('gantt');
    if (bcfPanelVisible) panels.add('bcf');
    if (idsPanelVisible) panels.add('ids');
    if (lensPanelVisible) panels.add('lens');
    if (clashPanelVisible) panels.add('clash');
    if (comparePanelVisible) panels.add('compare');
    if (extensionsPanelVisible) panels.add('extensions');
    if (activeTool === 'addElement') panels.add('addElement');
    if (layersPanelVisible) panels.add('layers');
    if (collabPanelVisible) panels.add('collab');
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
    scriptPanelVisible,
  ]);

  const workspacePanelLabel = useMemo(() => {
    if (activeWorkspacePanels.size === 0) return null;
    if (activeWorkspacePanels.size > 1) return 'Multiple Panels';
    if (activeWorkspacePanels.has('script')) return 'Script Editor';
    if (activeWorkspacePanels.has('list')) return 'Lists';
    if (activeWorkspacePanels.has('gantt')) return 'Schedule';
    if (activeWorkspacePanels.has('bcf')) return 'BCF Issues';
    if (activeWorkspacePanels.has('ids')) return 'IDS Validation';
    if (activeWorkspacePanels.has('lens')) return 'Lens Rules';
    if (activeWorkspacePanels.has('clash')) return 'Clash Detection';
    if (activeWorkspacePanels.has('compare')) return 'Compare Models';
    if (activeWorkspacePanels.has('extensions')) return 'Extensions';
    if (activeWorkspacePanels.has('addElement')) return 'Add Element';
    if (activeWorkspacePanels.has('layers')) return 'Layer Stack';
    if (activeWorkspacePanels.has('collab')) return 'Collaboration Room';
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
