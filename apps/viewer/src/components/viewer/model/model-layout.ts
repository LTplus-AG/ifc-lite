/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which Plan ‖ 3D layout the Model workspace actually shows (charter #6232,
 * M2.4), from the user's pick and the width the split has: the viewport
 * panel beside the rail, so the hierarchy and the sidebar are already paid
 * for.
 *
 * The one hard rule: the 3D pane never gets narrower than its HUD needs.
 * `MODEL_3D_MIN_PX` is MEASURED, not chosen: the viewport-hud.e2e states
 * (idle, selection, split, room and element bars, measure, section and
 * its cap/box, floor plan + drawing, solo, banners) on AC20-FZK-Haus, swept
 * over 3D pane widths (`modelling-refactor/sc-m2-plan-hud-sweep.mjs`) on
 * main after #6315's HUD lane reserve. The last collision to clear was the
 * widest element bar against the storey chip (the old free-standing add panel's, now gone): Linux Chrome (the CI e2e) is
 * clean from 546 px, Windows Chrome from 534 px; the minimum is the larger
 * plus a margin for fonts not measured. (The old sketch bar's one-row
 * check was not a width floor: it wraps in bands at 3D-only widths too, e.g.
 * 703-836 and 933+ px panes, see the M2.4 PR.) Re-measure whenever the HUD's
 * widest bars change.
 *
 * - 'auto' (never picked): Plan ‖ 3D when both fit, else 3D alone, the plan
 *   one click away.
 * - an explicit 'split' / 'plan' is kept, but a split too narrow for both
 *   panes shows 3D alone until there is room again (nothing is persisted).
 * - 'plan' is the plan as large as it can be: the 3D pane at its minimum.
 */

import { useSyncExternalStore } from 'react';
import type { ModelLayout, ModelLayoutPick } from '@/store/slices/authoringSessionSidebar';

/** The narrowest 3D pane whose HUD shows every state without a collision (measured, see above). */
export const MODEL_3D_MIN_PX = 560;
/**
 * The narrowest plan pane: its header in one row (measured: the grid, Fit and
 * Plan | Split | 3D controls take 152 px, the storey chip 136 px with the
 * name truncated to about 40 px, plus padding; 308 px fits with no overflow).
 */
export const PLAN_MIN_PX = 300;
/** The resize handle between the panes (`w-1.5`). */
const HANDLE_PX = 6;
/** The plan's share in Split when there is room to spare. */
const SPLIT_PLAN_SHARE = 0.4;

/** Both panes fit side by side at their minimums. */
export function splitFits(groupWidth: number): boolean {
  return groupWidth >= MODEL_3D_MIN_PX + PLAN_MIN_PX + HANDLE_PX;
}

export function effectiveModelLayout(pick: ModelLayoutPick, groupWidth: number): ModelLayout {
  if (pick === '3d' || !splitFits(groupWidth)) return '3d';
  return pick === 'auto' ? 'split' : pick;
}

/** The plan pane's width in px for a layout that shows it (the 3D pane gets the rest, never below its minimum). */
export function planPaneWidth(layout: 'plan' | 'split', groupWidth: number): number {
  const most = groupWidth - MODEL_3D_MIN_PX - HANDLE_PX;
  return Math.max(PLAN_MIN_PX, layout === 'plan' ? most : Math.min(most, Math.round(groupWidth * SPLIT_PLAN_SHARE)));
}

/**
 * The split's measured width, published by `ModelWorkspaceSplit` so the
 * rail's plan toggle (outside the split) knows whether the plan fits. The
 * toggle lives in the rail on purpose: a strip beside the 3D pane took 24 px
 * from it, and the HUD's bar tiers, which measure the lane, then chose a bar
 * too wide for it (the room bar wrapped at 1600 px).
 */
let splitWidth = 0;
const listeners = new Set<() => void>();

export function publishSplitWidth(width: number): void {
  if (width === splitWidth) return;
  splitWidth = width;
  for (const listener of listeners) listener();
}

export function useSplitWidth(): number {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => splitWidth,
    () => splitWidth,
  );
}
