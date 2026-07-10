/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour snapshot/restore: cheap UI-only state captured at tour start.
 *
 * The contract (adjudicated in the tour-system review):
 * - Finish restores everything EXCEPT the tour's `keepOnFinish` fields, so a
 *   tour's visible outcome can survive. Abort restores everything.
 * - When the loaded model set changed during the run (demo load, user open),
 *   camera and selection are NOT restored from the snapshot - stale poses
 *   and refs onto a different model are worse than fresh framing. Transient
 *   view state (selection, storey isolation) is cleared to defaults instead.
 * - Cross-file workspace prefs (sidebar order/hidden set, float layout,
 *   section cap style) are never captured; the tour does not own them.
 */

import type { ViewerState } from '@/store';
import type { UiSnapshot, UiSnapshotKey, ViewerStoreApi } from './types';

export function captureUiSnapshot(store: ViewerStoreApi): UiSnapshot {
  const s = store.getState();
  return {
    sidebarMode: s.sidebarMode,
    openSidePanel: s.bcfPanelVisible ? 'bcf'
      : s.idsPanelVisible ? 'ids'
      : s.lensPanelVisible ? 'lens'
      : s.clashPanelVisible ? 'clash'
      : s.comparePanelVisible ? 'compare'
      : s.extensionsPanelVisible ? 'extensions'
      : null,
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    bottomPanel: s.scriptPanelVisible ? 'script' : s.ganttPanelVisible ? 'gantt' : s.listPanelVisible ? 'lists' : null,
    activeTool: s.activeTool,
    editEnabled: s.editEnabled,
    propertiesActiveTab: s.propertiesActiveTab,
    selection: {
      selectedEntityId: s.selectedEntityId,
      selectedEntityIds: [...s.selectedEntityIds],
      selectedEntity: s.selectedEntity,
      selectedEntitiesSet: [...s.selectedEntitiesSet],
      selectedEntities: [...s.selectedEntities],
      selectedModelId: s.selectedModelId,
    },
    activeStorey: s.activeStorey,
    selectedStoreys: [...s.selectedStoreys],
    sectionPlane: {
      axis: s.sectionPlane.axis,
      position: s.sectionPlane.position,
      enabled: s.sectionPlane.enabled,
      flipped: s.sectionPlane.flipped,
      custom: s.sectionPlane.custom ? structuredClone(s.sectionPlane.custom) : undefined,
    },
    activeLensId: s.activeLensId,
    camera: s.cameraCallbacks.getViewpoint?.() ?? null,
    modelIdsAtStart: [...s.models.keys()],
  };
}

function modelSetChanged(snapshot: UiSnapshot, state: ViewerState): boolean {
  const current = new Set(state.models.keys());
  if (current.size !== snapshot.modelIdsAtStart.length) return true;
  return snapshot.modelIdsAtStart.some((id) => !current.has(id));
}

export function restoreUiSnapshot(
  store: ViewerStoreApi,
  snapshot: UiSnapshot,
  keepOnFinish: readonly UiSnapshotKey[] = [],
): void {
  const keep = new Set(keepOnFinish);
  const s = store.getState();
  const modelsChanged = modelSetChanged(snapshot, s);

  // Panels first: showWorkspacePanel is the single sanctioned transition (it
  // re-docks floats/pop-outs and the exclusivity subscription tracks it).
  if (!keep.has('openSidePanel')) {
    s.showWorkspacePanel(snapshot.openSidePanel ?? 'properties');
  }
  if (!keep.has('bottomPanel')) {
    if (snapshot.bottomPanel) {
      s.showWorkspacePanel(snapshot.bottomPanel);
    } else {
      store.setState({ scriptPanelVisible: false, ganttPanelVisible: false, listPanelVisible: false });
    }
  }

  // Tool, then editEnabled explicitly - setActiveTool auto-flips it.
  if (!keep.has('activeTool')) {
    s.setActiveTool(snapshot.activeTool);
    s.setEditEnabled(snapshot.editEnabled);
  }

  // Selection + storey isolation: restore when the model set is unchanged,
  // otherwise clear both channels (stale refs must never be applied).
  if (!keep.has('selection')) {
    if (modelsChanged) {
      store.setState({
        selectedEntityId: null,
        selectedEntityIds: new Set<number>(),
        selectedEntity: null,
        selectedEntitiesSet: new Set<string>(),
        selectedEntities: [],
        selectedModelId: null,
        selectedStoreys: new Set<number>(),
        activeStorey: null,
      });
    } else {
      store.setState({
        selectedEntityId: snapshot.selection.selectedEntityId,
        selectedEntityIds: new Set(snapshot.selection.selectedEntityIds),
        selectedEntity: snapshot.selection.selectedEntity,
        selectedEntitiesSet: new Set(snapshot.selection.selectedEntitiesSet),
        selectedEntities: [...snapshot.selection.selectedEntities],
        selectedModelId: snapshot.selection.selectedModelId,
        selectedStoreys: new Set(snapshot.selectedStoreys),
        activeStorey: snapshot.activeStorey,
      });
    }
  }

  // Section plane: merge the model-relative fields (including a face-picked
  // custom plane) over current state, preserving the user's persisted cap
  // appearance prefs.
  if (!keep.has('sectionPlane')) {
    store.setState({
      sectionPlane: {
        ...store.getState().sectionPlane,
        axis: snapshot.sectionPlane.axis,
        position: snapshot.sectionPlane.position,
        enabled: snapshot.sectionPlane.enabled,
        flipped: snapshot.sectionPlane.flipped,
        custom: snapshot.sectionPlane.custom,
      },
    });
  }

  if (!keep.has('activeLensId') && store.getState().activeLensId !== snapshot.activeLensId) {
    s.setActiveLens(snapshot.activeLensId);
  }

  if (!keep.has('propertiesActiveTab')) {
    s.setPropertiesActiveTab(snapshot.propertiesActiveTab);
  }

  // Sidebar mode + collapse flags LAST, after showWorkspacePanel and the
  // exclusivity subscription have settled (they force-expand the sidebar).
  if (!keep.has('sidebarMode')) s.setSidebarMode(snapshot.sidebarMode);
  if (!keep.has('leftPanelCollapsed')) s.setLeftPanelCollapsed(snapshot.leftPanelCollapsed);
  if (!keep.has('rightPanelCollapsed')) s.setRightPanelCollapsed(snapshot.rightPanelCollapsed);

  // Camera: only onto the same model set; fresh framing beats a stale pose.
  if (!keep.has('camera') && !modelsChanged && snapshot.camera) {
    store.getState().cameraCallbacks.applyViewpoint?.(snapshot.camera, true, 600);
  }
}
