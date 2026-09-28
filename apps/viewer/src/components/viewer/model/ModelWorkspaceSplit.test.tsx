/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's Plan ‖ 3D split (charter #6232, M2.1). Switching from
 * the 3D layout to Split or Plan mounts the plan pane. Resizing it in the
 * same commit threw "Layout not found for Panel model-plan-panel", and that
 * throw blanked the whole viewer (#6315). A persisted 'split' layout crashed
 * workspace entry the same way.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { ModelWorkspaceSplit } from './ModelWorkspaceSplit';

function mount(): HTMLElement {
  return render(<ModelWorkspaceSplit><div data-viewport-stub /></ModelWorkspaceSplit>);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setModelLayout('3d');
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  useViewerStore.getState().setModelLayout('3d');
});

describe('ModelWorkspaceSplit (#6232 M2.1)', () => {
  for (const layout of ['split', 'plan'] as const) {
    it(`mounts the plan pane on a 3D -> ${layout} switch without throwing, the viewport kept`, async () => {
      const ui = mount();
      act(() => { useViewerStore.getState().enterModelWorkspace(); });
      const viewport = ui.querySelector('[data-viewport-stub]');
      assert.ok(viewport, 'the viewport renders in 3D');
      assert.equal(ui.querySelector('[data-model-plan-pane]'), null, 'no plan pane in 3D');

      act(() => { useViewerStore.getState().setModelLayout(layout); });
      await act(frame);

      assert.ok(ui.querySelector('[data-model-plan-pane]'), 'the plan pane mounted');
      assert.equal(ui.querySelector('[data-model-layout]')?.getAttribute('data-model-layout'), layout);
      assert.equal(ui.querySelector('[data-viewport-stub]'), viewport, 'the 3D viewport was not remounted');
    });
  }

  it('enters the workspace with a saved Split layout without throwing', async () => {
    useViewerStore.getState().setModelLayout('split');
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    await act(frame);
    assert.ok(ui.querySelector('[data-model-plan-pane]'), 'the plan pane mounted on entry');
  });
});
