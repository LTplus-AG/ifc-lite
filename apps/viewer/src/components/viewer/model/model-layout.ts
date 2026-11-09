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
 * Re-measured for #8802 R1 over the current 25 states (the same sweep, 3D
 * layout forced, window widths 1040-1420): the measure, section and align
 * bars have grown since, and their min-content (the measure bar's mode
 * group alone is 268 px) no longer fits the lane between the 14rem chip
 * reserve and the ViewCube below a 602 px pane on Linux Chrome; 596-600 px
 * panes collide with the storey chip and the cube. R1's thinner shell made
 * the 1600 px split 881 px wide, enough for the old 560 px floor to open
 * Plan ‖ 3D with a 566 px 3D pane, which the viewport-hud e2e caught.
 *
 * - 'auto' (never picked): Plan ‖ 3D when both fit, else 3D alone, the plan
 *   one click away.
 * - an explicit 'split' / 'plan' is kept, but a split too narrow for both
 *   panes shows 3D alone until there is room again (nothing is persisted).
 * - 'plan' is the plan as large as it can be: the 3D pane at its minimum.
 */

import { useSyncExternalStore } from 'react';
import type { ModelLayout, ModelLayoutPick } from '@/store/slices/authoringSessionSidebar';

/** The retained 3D width floor; the viewport-HUD matrix guards it as controls move to the workspace bar. */
export const MODEL_3D_MIN_PX = 620;
/** The plan keeps at least 300px of usable canvas; its controls live in the shared workspace bar. */
export const PLAN_MIN_PX = 300;
/** The resize handle between the panes: a 1px `.shell-splitter-v` (#8802 R1; its hit area is a pseudo-element). */
export const HANDLE_PX = 1;
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

/** The measured pane-group width, shared with explicit layout picks when they try to make room. */
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

/** Current measured split width for command eligibility; same publisher as the rail. */
export function getSplitWidth(): number { return splitWidth; }
