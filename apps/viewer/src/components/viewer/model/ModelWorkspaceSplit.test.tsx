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
// A measured 1280 px split: wide enough for Plan ‖ 3D under `model-layout.ts` (#6232 M2.4).
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { activate, cleanup, render } from '@/test/render.js';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { RibbonToolbar } from '../ribbon/RibbonToolbar';
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
      assert.equal(ui.querySelector('[data-model-plan-pane]')?.getAttribute('aria-hidden'), 'true', 'the plan is hidden in 3D');

      act(() => { useViewerStore.getState().setModelLayout(layout); });
      await act(frame);

      assert.ok(ui.querySelector('[data-model-plan-pane]'), 'the plan pane mounted');
      assert.equal(ui.querySelector('[data-model-layout]')?.getAttribute('data-model-layout'), layout);
      assert.equal(ui.querySelector('[data-viewport-stub]'), viewport, 'the 3D viewport was not remounted');
    });
  }

  it('collapses only for a narrow Split and restores the sidebar on leave (#9296)', async (t) => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function(this: HTMLElement) {
      const box = original.call(this);
      return this.hasAttribute('data-model-split-width') ? { ...box, width: 700 } : box;
    });
    useViewerStore.getState().setSidebarMode('expanded');
    useViewerStore.getState().setModelLayout('split');
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    await act(frame);
    assert.equal(useViewerStore.getState().sidebarMode, 'collapsed');
    // #9296 review: entry with the saved layout falls back quietly; only an explicit pick explains.
    assert.equal(ui.querySelector('[data-model-layout-notice]') === null, true, 'no notice on entry');
    act(() => { useViewerStore.getState().setModelLayout('split'); });
    assert.ok(ui.querySelector('[data-model-layout-notice]'), 'the fallback explains why the picked Split cannot fit');
    act(() => { useViewerStore.getState().setModelLayout('3d'); });
    assert.equal(ui.querySelector('[data-model-layout-notice]') === null, true, 'picking 3D clears the notice');
    act(() => { useViewerStore.getState().exitModelWorkspace(); });
    assert.equal(useViewerStore.getState().sidebarMode, 'expanded');
  });

  for (const layout of ['plan', 'split', '3d'] as const) {
    it(`has one workspace bar and storey picker in ${layout} (#9296)`, async () => {
      useViewerStore.getState().setModelLayout(layout);
      const ui = mount();
      act(() => { useViewerStore.getState().enterModelWorkspace(); });
      await act(frame);
      assert.equal(ui.querySelectorAll('[data-workspace-bar]').length, 1);
      assert.equal(ui.querySelectorAll('[data-workspace-storey-chip]').length, 1);
      assert.equal(ui.querySelectorAll('[role="radiogroup"][aria-label="Layout"]').length, 1);
      assert.equal(ui.querySelectorAll('[data-workspace-leave]').length, 1);
    });
  }

  // #9296 review: Leave unmounts with the bar, which dropped focus to <body>.
  it('Leave names its key and hands focus back to the Model button (#9296)', async () => {
    useViewerStore.getState().setModelLayout('3d');
    const ui = render(<><RibbonToolbar /><ModelWorkspaceSplit><div data-viewport-stub /></ModelWorkspaceSplit></>);
    const model = ui.querySelector<HTMLButtonElement>('[data-command-id="tool:edit-mode"]')!;
    activate(model, 'Enter');
    await act(frame);
    const leave = ui.querySelector<HTMLButtonElement>('[data-workspace-leave]')!;
    assert.match(leave.textContent ?? '', /Leave\s*· M$/);
    activate(leave, ' ');
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(ui.querySelector('[data-workspace-leave]') === null, true, 'the bar is gone');
    assert.equal(document.activeElement === model, true, 'focus is back on the Model button');
  });

  it('enters the workspace with a saved Split layout without throwing', async () => {
    useViewerStore.getState().setModelLayout('split');
    const ui = mount();
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    await act(frame);
    assert.ok(ui.querySelector('[data-model-plan-pane]'), 'the plan pane mounted on entry');
  });
});
