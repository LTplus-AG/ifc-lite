/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchor resolution for tour steps.
 *
 * The sidebar is single-tenant, so an anchor inside an inactive panel does
 * not exist in the DOM yet - the retry loop is what distinguishes "panel is
 * still mounting after prepare()" from real rot. Panels living in another OS
 * window (pop-out) are re-docked first: a main-document overlay cannot
 * spotlight another window. A step's panel that is closed (the user skipped
 * the tour's own "open the panel" step, or closed it mid-tour) is opened in
 * its home region, so one skip no longer breaks every later step (#5608).
 */

import { anchorSelector } from './anchors';
import type { TourBrokenReason, TourStep, ViewerStoreApi } from './types';

const RESOLVE_TIMEOUT_MS = 2000;

export interface AnchorResolution {
  el: HTMLElement | null;
  reason?: TourBrokenReason;
  /** The engine re-docked a floating / popped-out panel to reach the anchor. */
  redocked: boolean;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * @param isCurrent Bail-out check: resolution is abandoned when the step it
 *   was started for is no longer the active one.
 */
export async function resolveAnchor(
  store: ViewerStoreApi,
  step: TourStep,
  isCurrent: () => boolean,
): Promise<AnchorResolution> {
  if (!step.anchor) return { el: null, reason: 'anchor-missing', redocked: false };

  const selector = anchorSelector(step.anchor);
  let redocked = false;
  if (step.panel) {
    const s = store.getState();
    const detached = s.floatingPanels.some((p) => p.id === step.panel)
      || s.poppedOutIds.includes(step.panel);
    if (detached || !document.querySelector(selector)) {
      s.showWorkspacePanel(step.panel, 'programmatic');
      redocked = detached;
    }
  }

  const deadline = performance.now() + RESOLVE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!isCurrent()) return { el: null, redocked };
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.isConnected) return { el, redocked };
    await nextFrame();
  }

  // Exhausted. A rail anchor whose panel the user hid from the activity bar
  // is not rot - report it distinctly so the PostHog rot insight stays clean.
  const hidden = step.panel
    ? store.getState().sidebarHiddenIds.includes(step.panel)
    : false;
  return { el: null, reason: hidden ? 'panel-hidden-by-user' : 'anchor-missing', redocked };
}
