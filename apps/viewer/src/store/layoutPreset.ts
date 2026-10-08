/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Applying and undoing a workspace layout preset (#6926).
 *
 * Applying is always an explicit user action. Before the first preset is
 * applied, the user's own layout (rail order / hidden set / mode / width,
 * docked pane, split and its ratio, Assistant placement) is captured and
 * persisted, so "Restore my layout" brings it back exactly, also after a
 * reload. Applying a preset again keeps that original capture. The one
 * "Reset layout" (`layoutReset.ts`) discards the capture, since it replaces
 * the user's layout with the shipped default anyway.
 */

import { create } from 'zustand';
import { LAYOUT_PRESET_STORAGE_KEY as STORAGE_KEY, layoutPresetResetEpoch, subscribeLayoutPresetReset } from './layout-preset-reset';
import { getViewerStoreApi } from './index.js';
import type { SidebarLayoutSnapshot } from './slices/sidebarSlice.js';
import { getLayoutPreset, planLayoutPreset, type LayoutPresetId, type LayoutPresetPlan, type WorkspaceLayoutState } from '@/lib/panels/layout-presets';
import { isWorkspacePanelId, migratePanelId, type WorkspacePanelId } from '@/lib/panels/registry';
import { isAssistantPlacement, setAssistantPlacement, useAssistantPlacement, watchSplitRestore, type AssistantPlacement } from '@/lib/assistant/placement';
import { closePanelWindow } from '@/services/panel-windows';

type ViewerStoreApi = ReturnType<typeof getViewerStoreApi>;

/** The user's layout as a preset could change it. */
export interface WorkspaceLayoutSnapshot {
  sidebar: SidebarLayoutSnapshot;
  primary: WorkspacePanelId;
  secondary: WorkspacePanelId | null;
  splitRatio: number;
  assistantPlacement: AssistantPlacement;
  assistantDisplacedSecondary?: WorkspacePanelId | null;
}

interface PresetRecord {
  version: 1;
  active: LayoutPresetId;
  previous: WorkspaceLayoutSnapshot;
}



function panelId(value: unknown): WorkspacePanelId | null {
  return typeof value === 'string' ? migratePanelId(value) ?? null : null;
}

function decodeRecord(value: unknown): PresetRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const previous = record.previous as Record<string, unknown> | undefined;
  if (record.version !== 1 || typeof record.active !== 'string' || !getLayoutPreset(record.active) || !previous) return null;
  const primary = panelId(previous.primary);
  const secondary = previous.secondary === null ? null : panelId(previous.secondary);
  if (!primary || (previous.secondary !== null && !secondary) || !previous.sidebar || typeof previous.sidebar !== 'object'
    || typeof previous.splitRatio !== 'number' || !isAssistantPlacement(previous.assistantPlacement)) return null;
  return {
    version: 1,
    active: record.active as LayoutPresetId,
    // The sidebar blob goes through `applySidebarLayout`, which normalises any stale or foreign shape.
    previous: { sidebar: previous.sidebar as SidebarLayoutSnapshot, primary, secondary, splitRatio: previous.splitRatio,
      assistantPlacement: previous.assistantPlacement,
      assistantDisplacedSecondary: panelId(previous.assistantDisplacedSecondary) },
  };
}

function loadRecord(): PresetRecord | null {
  if (typeof window === 'undefined' || layoutPresetResetEpoch() > 0) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? decodeRecord(JSON.parse(raw)) : null;
  } catch (error) {
    console.warn('[layout-preset] ignoring unreadable preset record:', error);
    return null;
  }
}

function persistRecord(record: PresetRecord | null): void {
  try {
    if (record) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[layout-preset] failed to persist preset record:', error);
  }
}

export const useLayoutPreset = create<{ record: PresetRecord | null }>(() => ({ record: loadRecord() }));
subscribeLayoutPresetReset(() => useLayoutPreset.setState({ record: null }));

function setRecord(record: PresetRecord | null): void {
  persistRecord(record);
  useLayoutPreset.setState({ record });
}

function detachedIds(state: ReturnType<ViewerStoreApi['getState']>): Set<WorkspacePanelId> {
  return new Set<WorkspacePanelId>([...state.floatingPanels.map((panel) => panel.id), ...state.poppedOutIds]);
}

export function captureWorkspaceLayout(store: ViewerStoreApi = getViewerStoreApi()): WorkspaceLayoutSnapshot {
  const state = store.getState();
  return {
    sidebar: state.serializeSidebarLayout(),
    primary: state.sidebarActivePanel,
    secondary: state.sidebarSecondaryPanel,
    splitRatio: state.sidebarSplitRatio,
    assistantPlacement: useAssistantPlacement.getState().placement,
    assistantDisplacedSecondary: useAssistantPlacement.getState().displacedSecondary,
  };
}

function currentState(store: ViewerStoreApi): WorkspaceLayoutState {
  const state = store.getState();
  return {
    order: state.sidebarOrder,
    hiddenIds: state.sidebarHiddenIds,
    expanded: state.sidebarMode === 'expanded',
    primary: state.sidebarActivePanel,
    secondary: state.sidebarSecondaryPanel,
    detached: detachedIds(state),
    assistantPlacement: useAssistantPlacement.getState().placement,
  };
}

/** What applying would change. Reads only; the preview never touches the layout. */
export function previewLayoutPreset(id: LayoutPresetId, store: ViewerStoreApi = getViewerStoreApi()): LayoutPresetPlan {
  const preset = getLayoutPreset(id);
  if (!preset) throw new Error(`Unknown layout preset ${id}`);
  return planLayoutPreset(currentState(store), preset);
}

export function applyLayoutPreset(id: LayoutPresetId, store: ViewerStoreApi = getViewerStoreApi()): LayoutPresetPlan {
  const plan = previewLayoutPreset(id, store);
  const previous = useLayoutPreset.getState().record?.previous ?? captureWorkspaceLayout(store);
  const state = store.getState();
  state.applySidebarLayout({ ...state.serializeSidebarLayout(), mode: 'expanded', order: plan.order, hiddenIds: plan.hiddenIds });
  if (plan.primary) {
    state.showWorkspacePanel(plan.primary, 'programmatic');
    if (plan.secondary) {
      closePanelWindow(plan.secondary);
      store.getState().setSidebarSecondaryPanel(plan.secondary);
    } else {
      store.getState().setSidebarSecondaryPanel(null);
    }
  }
  setAssistantPlacement(plan.assistantPlacement);
  setRecord({ version: 1, active: id, previous });
  return plan;
}

/** Put back the layout captured before the first preset was applied. */
export function restoreLayoutBeforePreset(store: ViewerStoreApi = getViewerStoreApi()): boolean {
  const record = useLayoutPreset.getState().record;
  if (!record) return false;
  const { previous } = record;
  const state = store.getState();
  const detached = detachedIds(store.getState());
  if (!detached.has(previous.primary)) state.showWorkspacePanel(previous.primary, 'programmatic');
  const secondary = previous.secondary && isWorkspacePanelId(previous.secondary) && !detached.has(previous.secondary) ? previous.secondary : null;
  if (secondary === 'assistant') watchSplitRestore(store);
  store.getState().setSidebarSecondaryPanel(secondary);
  store.getState().setSidebarSplitRatio(previous.splitRatio);
  // Opening the previous panel expands the dock; restore the captured mode and rail afterwards.
  store.getState().applySidebarLayout(previous.sidebar);
  setAssistantPlacement(previous.assistantPlacement);
  useAssistantPlacement.setState({ displacedSecondary: previous.assistantDisplacedSecondary ?? null });
  setRecord(null);
  return true;
}
