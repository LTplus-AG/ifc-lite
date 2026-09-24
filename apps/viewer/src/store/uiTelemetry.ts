/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Store-side UI interaction events (#5618). The panel and tool actions are the
// choke points every entry point already routes through, so the events are
// emitted there once instead of per button; the entry point passes only the
// surface (or exit route) the action itself cannot know.

import { trackUiEvent } from '@/lib/analytics';
import type { ToolExitVia, UiSurface } from '@/lib/analytics-ui-events';
import type { WorkspacePanelId } from '@/lib/panels/registry';

export type { ToolExitVia, UiSurface };

/**
 * `panel_opened`, plus `panel_replaced` when a side panel takes the
 * single-tenant slot from another one (`replacing`: the slot's previous
 * occupant; `properties` is the empty fallback, so it is never "replaced").
 */
export function trackPanelOpened(panel: WorkspacePanelId, surface?: UiSurface, replacing?: WorkspacePanelId): void {
  if (replacing === panel) return;
  trackUiEvent('panel_opened', { panel_id: panel, surface });
  if (replacing && replacing !== 'properties') trackUiEvent('panel_replaced', { from: replacing, to: panel });
}

/** `tool_exited` for the tool being left and `tool_activated` for the new one; Select is the resting state, not a tool. */
export function trackToolChange(from: string, to: string, via: ToolExitVia = 'switch'): void {
  if (from === to) return;
  if (from !== 'select') trackUiEvent('tool_exited', { tool: from, via });
  if (to !== 'select') trackUiEvent('tool_activated', { tool: to });
}
