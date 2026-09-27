/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The classic toolbar and the ribbon share this hook, which opens most side
 * panels by flipping their flags directly rather than through the store's
 * panel actions. The open must still be reported, with the surface the hook
 * was mounted for (#5618).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from './useWorkspacePanelControls.js';

function mountHook(): { current: ReturnType<typeof useWorkspacePanelControls> } {
  const ref = { current: null as unknown as ReturnType<typeof useWorkspacePanelControls> };
  function Probe() {
    ref.current = useWorkspacePanelControls('ribbon');
    return null;
  }
  render(<Probe />);
  return ref;
}

let captured: unknown[][] = [];
beforeEach(() => {
  useViewerStore.setState({ bcfPanelVisible: false, sourcesPanelVisible: false, floatingPanels: [] });
  captured = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
});
afterEach(() => { cleanup(); mock.restoreAll(); });

describe('useWorkspacePanelControls surface (#5618)', () => {
  it('reports a flag-driven side-panel open, and a bottom-panel open, with its surface', () => {
    const hook = mountHook();
    act(() => { hook.current.handleToggleRightPanel('sources'); });
    act(() => { hook.current.handleToggleBottomPanel('lists'); });
    const opened = captured.filter(([name]) => name === 'panel_opened');
    assert.deepEqual(opened, [
      ['panel_opened', { panel_id: 'sources', surface: 'ribbon' }],
      ['panel_opened', { panel_id: 'lists', surface: 'ribbon' }],
    ]);
  });

  it('reports nothing when the click closes the panel', () => {
    const hook = mountHook();
    act(() => { hook.current.handleToggleRightPanel('sources'); });
    captured = [];
    act(() => { hook.current.handleToggleRightPanel('sources'); });
    assert.deepEqual(captured.filter(([name]) => name === 'panel_opened'), []);
  });
});
