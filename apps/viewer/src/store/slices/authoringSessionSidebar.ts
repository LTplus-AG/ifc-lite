/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's sidebar and layout bookkeeping (charter #6232, M2).
 *
 * Entering the workspace shows the Model inspector in the right sidebar and
 * remembers what was there; leaving puts it back, unless the user switched
 * panels meanwhile (their choice wins). Phones are skipped: there the panel
 * is a bottom sheet that would cover the viewport the user is about to
 * draw in.
 *
 * The plan ‖ 3D layout is a per-browser preference, like the side-by-side
 * drawing preset.
 */

import type { ViewerState } from '../index.js';
import type { SidebarMode } from './sidebarSlice.js';
import type { WorkspacePanelId } from '@/lib/panels/registry';

export type ModelLayout = 'plan' | 'split' | '3d';
/**
 * What the user chose: a layout, or 'auto' while they never picked one. 'auto'
 * opens Plan ‖ 3D only where the 3D pane stays wide enough for its HUD
 * (`components/viewer/model/model-layout.ts`).
 */
export type ModelLayoutPick = ModelLayout | 'auto';

/** What the sidebar showed before the workspace took it over. */
export interface SidebarRestore {
  readonly panel: WorkspacePanelId;
  readonly mode: SidebarMode;
}

const LAYOUT_KEY = 'ifc-lite:model-layout';
const LAYOUTS: readonly ModelLayout[] = ['plan', 'split', '3d'];

/** The layout the user picked (persisted), or 'auto' until they pick one. */
export function loadModelLayout(): ModelLayoutPick {
  try {
    const stored = globalThis.localStorage?.getItem(LAYOUT_KEY);
    return LAYOUTS.find((layout) => layout === stored) ?? 'auto';
  } catch (err) {
    console.warn('[modeling] Could not read the saved model layout:', err);
    return 'auto';
  }
}

export function persistModelLayout(layout: ModelLayout): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, layout);
  } catch (err) {
    console.warn('[modeling] Could not save the model layout:', err);
  }
}

/** Show the Model inspector; returns what to restore on exit, or null when nothing was taken over. */
export function showModelInspector(s: ViewerState): SidebarRestore | null {
  if (s.isMobile || s.sidebarActivePanel === 'model') return null;
  const restore: SidebarRestore = { panel: s.sidebarActivePanel, mode: s.sidebarMode };
  s.showWorkspacePanel('model');
  return restore;
}

/** Put the sidebar back, if it still shows the inspector the workspace opened. */
export function restoreSidebar(get: () => ViewerState, restore: SidebarRestore | null): void {
  if (!restore || get().sidebarActivePanel !== 'model') return;
  get().showWorkspacePanel(restore.panel);
  if (restore.mode !== get().sidebarMode) get().setSidebarMode(restore.mode);
}
