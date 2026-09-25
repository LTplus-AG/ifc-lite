/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global single-key shortcuts must respect the context they fire in (#5596):
 *   - while the Walk tool is active, W/A/S/D and the arrows are movement keys
 *     (useKeyboardControls), so A must not "Show all" and D must not toggle
 *     the presentation dock;
 *   - type-ahead in a focused native `<select>` must not run shortcuts.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

let initialState: ReturnType<typeof useViewerStore.getState>;

function Harness() {
  useKeyboardShortcuts();
  return null;
}

describe('useKeyboardShortcuts — context guards (#5596)', () => {
  beforeEach(() => {
    initialState = useViewerStore.getState();
    useViewerStore.getState().hideEntities([1, 2]);
    useViewerStore.setState({ basketPresentationVisible: false });
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useViewerStore.setState(initialState, true);
  });

  it('A still runs Show all outside the Walk tool (control)', () => {
    render(<Harness />);
    press(window, 'a');
    assert.equal(useViewerStore.getState().hiddenEntities.size, 0);
  });

  it('D toggles the presentation dock outside the Walk tool (control)', () => {
    render(<Harness />);
    press(window, 'd');
    assert.equal(useViewerStore.getState().basketPresentationVisible, true);
  });

  it('Walk + A / Alt+A keeps the hidden set, Walk + D / Alt+D leaves the presentation dock alone', () => {
    useViewerStore.getState().setActiveTool('walk');
    render(<Harness />);
    press(window, 'a');
    // A modifier must not reopen the path: the A/D handlers ignore Alt.
    press(window, 'a', { altKey: true });
    assert.equal(useViewerStore.getState().hiddenEntities.size, 2, 'A is a strafe key in Walk, not Show all');
    // D toggles, so assert after each press: two leaked toggles would cancel out.
    press(window, 'd');
    assert.equal(useViewerStore.getState().basketPresentationVisible, false, 'D is a strafe key in Walk');
    press(window, 'd', { altKey: true });
    assert.equal(useViewerStore.getState().basketPresentationVisible, false, 'Alt+D is a strafe key in Walk');
  });

  it('a keydown on a focused <select> does not run Show all', () => {
    render(<Harness />);
    const select = document.createElement('select');
    document.body.appendChild(select);
    press(select, 'a');
    assert.equal(useViewerStore.getState().hiddenEntities.size, 2);
  });
});
