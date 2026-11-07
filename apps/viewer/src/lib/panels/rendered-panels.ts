/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which panels are actually DRAWN right now, as the layout draws them, in one
 * place (#8802 R6 review).
 *
 * `SidebarDock` decides whether the right pane is drawn (`sidebarPaneDrawn`),
 * `SidebarPanelHost` what it shows (`sidebarPaneContent`), and `ViewerLayout`
 * which panel the bottom strip docks (`dockedBottomPanel`). They read these
 * functions instead of inline copies, so the activity rail, which pins only
 * drawn panels (`renderedPanelIds`), cannot drift from what is on screen.
 *
 * "Open" (`usePanelControls().isOpen`) is wider on purpose: a panel left
 * active in a collapsed sidebar is still the one the pane will show when it
 * expands, and the rail marks it so. It is not on screen, though, and a rail
 * that kept it pinned hid usable icons behind an invisible one.
 */

import type { SidebarMode } from './layout-migration';
import { activeBottomPanel, type BottomPanelFlags, type BottomPanelId } from './bottom-panels';
import type { WorkspacePanelId } from './registry';

/** `SidebarDock`: the right pane is drawn only when expanded and not folded for the start screen. */
export function sidebarPaneDrawn(mode: SidebarMode, foldedForStart: boolean): boolean {
  return mode === 'expanded' && !foldedForStart;
}

/**
 * `SidebarPanelHost`: the panel the pane shows (the active one, or Properties
 * when that one is detached, or nothing when Properties is detached too), and
 * the split's lower half: set, inline, distinct from the one shown, and only
 * beside a shown panel.
 */
export function sidebarPaneContent(
  activePanel: WorkspacePanelId,
  secondaryPanel: WorkspacePanelId | null,
  detached: (id: WorkspacePanelId) => boolean,
): { shown: WorkspacePanelId | null; secondary: WorkspacePanelId | null } {
  let shown: WorkspacePanelId | null = activePanel;
  if (detached(shown)) shown = 'properties';
  if (shown === 'properties' && detached('properties')) shown = null;
  const secondary = shown !== null && secondaryPanel !== null && secondaryPanel !== shown && !detached(secondaryPanel)
    ? secondaryPanel
    : null;
  return { shown, secondary };
}

/** `ViewerLayout`: the strip docks the flags' first panel in table order, unless that one is detached. */
export function dockedBottomPanel(flags: BottomPanelFlags, detached: (id: string) => boolean): BottomPanelId | null {
  const first = activeBottomPanel(flags);
  return first && !detached(first) ? first : null;
}

export interface RenderedPanelsInput {
  sidebarMode: SidebarMode;
  /** The start screen folds the right pane (`useEmptyStartFoldsSidebarPane`). */
  paneFoldedForStart: boolean;
  /** A right-placed analysis extension owns the pane; no registry panel is drawn in it. */
  rightExtensionActive: boolean;
  activePanel: WorkspacePanelId;
  secondaryPanel: WorkspacePanelId | null;
  /** The left slot is drawn: not collapsed and not folded for the start screen. */
  leftSlotOpen: boolean;
  bottomFlags: BottomPanelFlags;
  floatingIds: ReadonlySet<WorkspacePanelId>;
  poppedIds: ReadonlySet<WorkspacePanelId>;
}

/** Every panel drawn somewhere: the left slot, the right pane, the bottom strip, a floating or popped-out window. */
export function renderedPanelIds(input: RenderedPanelsInput): Set<WorkspacePanelId> {
  const detached = (id: string) => input.floatingIds.has(id as WorkspacePanelId) || input.poppedIds.has(id as WorkspacePanelId);
  const drawn = new Set<WorkspacePanelId>([...input.floatingIds, ...input.poppedIds]);
  if (input.leftSlotOpen) drawn.add('hierarchy');
  if (sidebarPaneDrawn(input.sidebarMode, input.paneFoldedForStart) && !input.rightExtensionActive) {
    const { shown, secondary } = sidebarPaneContent(input.activePanel, input.secondaryPanel, detached);
    if (shown) drawn.add(shown);
    if (secondary) drawn.add(secondary);
  }
  const bottom = dockedBottomPanel(input.bottomFlags, detached);
  if (bottom) drawn.add(bottom);
  return drawn;
}
