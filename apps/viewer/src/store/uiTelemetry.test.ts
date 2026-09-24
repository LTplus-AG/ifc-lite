/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI interaction events (#5618) are emitted at the store's choke points, so
 * every entry point is covered once. These drive the real store actions and
 * record what reaches the analytics client.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from '@/lib/analytics';
import { reportFileOpenRejected } from '@/hooks/ingest/fileOpenRejected';
import { bottomPanelFlags } from '@/lib/panels/bottom-panels';
import { useViewerStore } from './index.js';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from './homeView.js';

const state = () => useViewerStore.getState();
let captured: unknown[][] = [];

beforeEach(() => {
  state().setActiveTool('select');
  state().showWorkspacePanel('properties');
  useViewerStore.setState(bottomPanelFlags(null));
  captured = [];
  mock.method(posthog, 'capture', (...args: unknown[]) => { captured.push(args); });
});
afterEach(() => mock.restoreAll());

describe('panel events (#5618)', () => {
  it('reports the open with its surface, and the panel it replaced in the side slot', () => {
    state().openWorkspacePanel('clash');
    state().toggleWorkspacePanel('bcf', 'palette');
    assert.deepEqual(captured, [
      ['panel_opened', { panel_id: 'clash', surface: undefined }],
      ['panel_opened', { panel_id: 'bcf', surface: 'palette' }],
      ['panel_replaced', { from: 'clash', to: 'bcf' }],
    ]);
  });

  it('reports a bottom panel open without replacing the side panel, and a close not at all', () => {
    state().openWorkspacePanel('clash');
    captured = [];
    state().openPanelInHome('script', 'shortcut');
    state().toggleBottomPanel('script');
    state().toggleWorkspacePanel('clash');
    assert.deepEqual(captured, [['panel_opened', { panel_id: 'script', surface: 'shortcut' }]]);
  });
});

describe('tool events (#5618)', () => {
  it('reports activation, the exit route, and nothing for a no-op switch', () => {
    state().setActiveTool('measure');
    state().setActiveTool('measure');
    state().setActiveTool('section');
    state().setActiveTool('select', 'esc');
    assert.deepEqual(captured, [
      ['tool_activated', { tool: 'measure' }],
      ['tool_exited', { tool: 'measure', via: 'switch' }],
      ['tool_activated', { tool: 'section' }],
      ['tool_exited', { tool: 'section', via: 'esc' }],
    ]);
  });
});

describe('view_reset (#5618)', () => {
  it('names the trigger, including Home', () => {
    resetVisibilityForHomeFromStore('a');
    goHomeFromStore();
    assert.deepEqual(captured, [
      ['view_reset', { trigger: 'a' }],
      ['view_reset', { trigger: 'home' }],
    ]);
  });
});

describe('file_open_rejected (#5618)', () => {
  it('reports the reason category only, and explains a format we recognise', () => {
    assert.match(reportFileOpenRejected([new File([''], 'Client Tower.blend')]) ?? '', /^Client Tower\.blend: Blender scene/);
    assert.equal(reportFileOpenRejected([new File([''], 'notes.xyz')]), null);
    assert.deepEqual(captured, [
      ['file_open_rejected', { reason: 'unsupported_format' }],
      ['file_open_rejected', { reason: 'unrecognized_format' }],
    ]);
  });

  it('does not count a DXF-only pick, which loads as an underlay', () => {
    assert.equal(reportFileOpenRejected([new File([''], 'site.dxf')]), null);
    assert.deepEqual(captured, []);
  });
});
