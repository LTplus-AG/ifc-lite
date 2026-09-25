/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one "Reset layout" (#5854). Every entry point (activity-bar menu,
 * Customize sidebar, command palette) calls this, so "reset" always means
 * the whole workspace. Previously it reset only the sidebar, and floating
 * panels (the ones that end up off screen) were cleared only by the
 * close-all shortcut.
 *
 * Resets: the sidebar (mode, width, order, hidden panels, split), every
 * floating panel, the hierarchy pane (expanded on desktop, default width) and the
 * bottom strip's height. The last two live in components; they follow
 * `layoutResetEpoch`.
 */

import { getViewerStoreApi } from './index.js';
import { BOTTOM_STRIP_DEFAULT_HEIGHT, persistBottomStripHeight } from '@/lib/panels/bottom-strip-persistence';

/** The hierarchy pane's initial size in percent (`ViewerLayout`), and what a
 *  reset returns it to. The imperative `resize()` reads a bare number as
 *  pixels, so the reset passes it as a `%` string. */
export const LEFT_PANEL_DEFAULT_SIZE = 22;

export function resetLayout(store = getViewerStoreApi()): void {
  const state = store.getState();
  state.resetSidebarLayout();
  state.resetDockLayout();
  // The hierarchy pane is expanded by default on desktop only. On mobile a
  // non-collapsed left panel is the hierarchy SHEET, so expanding it would pop
  // a sheet over the model instead of restoring a layout (#5957).
  if (!state.isMobile) state.setLeftPanelCollapsed(false);
  // Persist the strip's default height here, not only in the mounted strip:
  // a strip that is not mounted (the mobile layout) would otherwise reopen at
  // the height the reset was meant to discard (#5957).
  persistBottomStripHeight(BOTTOM_STRIP_DEFAULT_HEIGHT);
  state.bumpLayoutResetEpoch();
}
