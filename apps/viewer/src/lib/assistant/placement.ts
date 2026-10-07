/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the contextual Assistant opens (#6926, U03).
 *
 * The Assistant is a registered side panel, so it can live in any existing
 * host. Opening it from a source panel's "Discuss with AI" action must not
 * replace the evidence the user is reviewing, so the user chooses explicitly:
 *
 * - `split`: the source keeps the docked pane and the Assistant opens in the
 *   lower half of the existing stacked split (#1266). The default.
 * - `dock`: the Assistant takes the docked pane; the source stays one click
 *   away through the Assistant's return target.
 * - `floating`: the Assistant opens as an in-app floating window (#1201).
 *
 * Below the measured stage minimum (the viewer's mobile layout) only one panel
 * fits, so the Assistant opens as the sheet and records the source as an
 * explicit return target whatever the preference says.
 *
 * The preference persists per browser. The return target and a split half
 * displaced by the Assistant are runtime-only.
 */

import { create } from 'zustand';
import { ASSISTANT_PLACEMENT_STORAGE_KEY, layoutPresetResetEpoch, subscribeLayoutPresetReset } from '@/store/layout-preset-reset';
import { getViewerStoreApi } from '@/store';
import { bottomPanelFlags, isBottomPanel, isBottomPanelOpen } from '@/lib/panels/bottom-panels';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { closePanelWindow } from '@/services/panel-windows';
import { trackPanelOpened } from '@/store/uiTelemetry';

export const ASSISTANT_PLACEMENTS = ['split', 'dock', 'floating'] as const;
export type AssistantPlacement = (typeof ASSISTANT_PLACEMENTS)[number];
export const DEFAULT_ASSISTANT_PLACEMENT: AssistantPlacement = 'split';

const STORAGE_KEY = ASSISTANT_PLACEMENT_STORAGE_KEY;

export function isAssistantPlacement(value: unknown): value is AssistantPlacement {
  return typeof value === 'string' && (ASSISTANT_PLACEMENTS as readonly string[]).includes(value);
}

function loadPlacement(): AssistantPlacement {
  if (typeof window === 'undefined' || layoutPresetResetEpoch() > 0) return DEFAULT_ASSISTANT_PLACEMENT;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isAssistantPlacement(stored) ? stored : DEFAULT_ASSISTANT_PLACEMENT;
  } catch (error) {
    console.warn('[assistant] ignoring unreadable placement preference:', error);
    return DEFAULT_ASSISTANT_PLACEMENT;
  }
}

interface PlacementState {
  placement: AssistantPlacement;
  /** The panel the Assistant was opened from; offered as "Back to …" while hidden. */
  returnTarget: WorkspacePanelId | null;
  /** A lower split half the Assistant took over, restored when the Assistant leaves the split. */
  displacedSecondary: WorkspacePanelId | null;
}

export const useAssistantPlacement = create<PlacementState>(() => ({
  placement: loadPlacement(),
  returnTarget: null,
  displacedSecondary: null,
}));

subscribeLayoutPresetReset(() => useAssistantPlacement.setState({ placement: DEFAULT_ASSISTANT_PLACEMENT, returnTarget: null, displacedSecondary: null }));

export function setAssistantPlacement(placement: AssistantPlacement): void {
  useAssistantPlacement.setState({ placement });
  try {
    window.localStorage.setItem(STORAGE_KEY, placement);
  } catch (error) {
    // Quota / private mode: the choice holds for this session only.
    console.warn('[assistant] failed to persist placement preference:', error);
  }
}

type ViewerStoreApi = ReturnType<typeof getViewerStoreApi>;

const restoreSubscriptions = new WeakSet<ViewerStoreApi>();

/** Put a displaced split half back once the Assistant leaves the split for nothing else. */
function watchSplitRestore(store: ViewerStoreApi): void {
  if (restoreSubscriptions.has(store)) return;
  restoreSubscriptions.add(store);
  store.subscribe((state, previous) => {
    if (previous.sidebarSecondaryPanel !== 'assistant' || state.sidebarSecondaryPanel === 'assistant') return;
    const displaced = useAssistantPlacement.getState().displacedSecondary;
    useAssistantPlacement.setState({ displacedSecondary: null });
    if (!displaced || state.sidebarSecondaryPanel !== null || state.sidebarActivePanel === displaced) return;
    if (state.floatingPanels.some((panel) => panel.id === displaced) || state.poppedOutIds.includes(displaced)) return;
    state.setSidebarSecondaryPanel(displaced);
  });
}

function isSidePanel(id: WorkspacePanelId): boolean {
  return getPanelDef(id)?.region === 'side';
}

function isDetached(state: ReturnType<ViewerStoreApi['getState']>, id: WorkspacePanelId): boolean {
  return state.floatingPanels.some((panel) => panel.id === id) || state.poppedOutIds.includes(id);
}

/**
 * Open the Assistant from a source panel under the user's placement choice.
 * `from` becomes the return target; `null` means no source (e.g. a command).
 */
export function openAssistant(from: WorkspacePanelId | null, store: ViewerStoreApi = getViewerStoreApi()): void {
  const returnTarget = from && from !== 'assistant' ? from : null;
  useAssistantPlacement.setState({ returnTarget });
  const state = store.getState();

  // Narrow layout: one sheet at a time. A docked bottom panel would win the
  // sheet (`resolveMobileSheet`), so clear the strip; the source reopens
  // through the return target with its own state intact.
  if (state.isMobile) {
    store.setState({ ...bottomPanelFlags(null) });
    state.showWorkspacePanel('assistant', 'context');
    return;
  }

  const placement = useAssistantPlacement.getState().placement;
  if (placement === 'floating') {
    if (state.sidebarSecondaryPanel === 'assistant') state.setSidebarSecondaryPanel(null);
    closePanelWindow('assistant');
    state.floatPanel('assistant');
    state.setRightPanelCollapsed(false);
    trackPanelOpened('assistant', 'context');
    return;
  }
  if (placement === 'dock') {
    state.showWorkspacePanel('assistant', 'context');
    return;
  }

  // Split: the source (or whatever owns the dock) stays on top, the Assistant goes below.
  const primary = state.sidebarActivePanel;
  const primaryDocked = !isDetached(state, primary);
  if (primary === 'assistant' && primaryDocked) return;
  const anchor = returnTarget && isSidePanel(returnTarget) && !isDetached(state, returnTarget)
    && (returnTarget === primary || returnTarget === state.sidebarSecondaryPanel)
    ? returnTarget
    : primaryDocked ? primary : 'properties';
  if (anchor !== primary || !primaryDocked) state.showWorkspacePanel(anchor, 'programmatic');
  const after = store.getState();
  const occupied = after.sidebarSecondaryPanel;
  if (occupied && occupied !== 'assistant' && occupied !== anchor) {
    useAssistantPlacement.setState({ displacedSecondary: occupied });
  }
  watchSplitRestore(store);
  after.closeFloatingPanel('assistant');
  after.setPanelPoppedOut('assistant', false);
  closePanelWindow('assistant');
  after.setSidebarSecondaryPanel('assistant');
  trackPanelOpened('assistant', 'context');
  if (after.sidebarMode !== 'expanded') after.setSidebarMode('expanded');
  if (after.rightPanelCollapsed) after.setRightPanelCollapsed(false);
}

/** Whether the return target is out of sight, so the Assistant should offer the way back. */
export function returnTargetHidden(
  state: ReturnType<ViewerStoreApi['getState']>,
  target: WorkspacePanelId,
): boolean {
  if (state.isMobile) return true;
  if (isDetached(state, target)) return false;
  if (isBottomPanel(target)) return !isBottomPanelOpen(state, target);
  if (target === 'hierarchy') return state.leftPanelCollapsed;
  return state.sidebarMode === 'collapsed' || state.rightPanelCollapsed
    || (state.sidebarActivePanel !== target && state.sidebarSecondaryPanel !== target);
}
