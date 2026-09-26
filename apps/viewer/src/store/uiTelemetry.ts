/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Store-side UI interaction events (#5618). The panel and tool actions are the
// choke points every entry point already routes through, so the events are
// emitted there once instead of per button; the entry point passes only the
// surface (or exit route) the action itself cannot know.

import { trackUiEvent } from '@/lib/analytics';
import type { PanelOpenSource, ToolChangeVia, UiSurface } from '@/lib/analytics-ui-events';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import type { StateCreator } from 'zustand';
import type { UISlice } from './slices/uiSlice.js';

export type { PanelOpenSource, ToolChangeVia, UiSurface };

/**
 * `panel_opened`, plus `panel_replaced` when a side panel takes the
 * single-tenant slot from another one (`replacing`: the slot's previous
 * occupant; `properties` is the empty fallback, so it is never "replaced").
 * A `programmatic` open is the app's, not the user's, and is not reported.
 */
export function trackPanelOpened(panel: WorkspacePanelId, source?: PanelOpenSource, replacing?: WorkspacePanelId): void {
  if (replacing === panel || source === 'programmatic') return;
  trackUiEvent('panel_opened', { panel_id: panel, surface: source });
  if (replacing && replacing !== 'properties') trackUiEvent('panel_replaced', { from: replacing, to: panel });
}

/**
 * Wrap the UI slice so `setActiveTool` reports `tool_exited` for the tool being
 * left and `tool_activated` for the new one (Select is the resting state, not
 * a tool). Compared after the call, so a change the collab gate rejects emits
 * nothing; a `programmatic` change (a tour step, a drawing) emits nothing. Kept out of uiSlice.ts, whose isolated tests run without the
 * browser globals posthog-js needs at import.
 */
export function withToolTelemetry<S extends UISlice>(
  create: StateCreator<S, [], [], UISlice>,
): StateCreator<S, [], [], UISlice> {
  return (set, get, api) => {
    const slice = create(set, get, api);
    return {
      ...slice,
      setActiveTool: (tool, via: ToolChangeVia = 'switch') => {
        const from = get().activeTool;
        slice.setActiveTool(tool, via);
        const to = get().activeTool;
        if (from === to || via === 'programmatic') return;
        if (from !== 'select') trackUiEvent('tool_exited', { tool: from, via });
        if (to !== 'select') trackUiEvent('tool_activated', { tool: to });
      },
    };
  };
}
