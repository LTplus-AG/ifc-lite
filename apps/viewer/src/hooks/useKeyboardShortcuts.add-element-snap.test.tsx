/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Add Element panel says snapping toggles with S, but S was only
 * bound in the Measure tool. S now flips the same `snapEnabled` flag the
 * add-element raycast reads while the Add Element tool is active.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { KEY_COMMANDS } from '@/lib/commands/keyboard-commands';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

let initialState: ReturnType<typeof useViewerStore.getState>;

function Harness() {
  useKeyboardShortcuts();
  return null;
}

describe('Add Element tool: S toggles snapping (#6233)', () => {
  beforeEach(() => {
    initialState = useViewerStore.getState();
    useViewerStore.setState({ activeTool: 'addElement', snapEnabled: true });
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useViewerStore.setState(initialState, true);
  });

  it('is a documented binding in the Add Element context', () => {
    const row = KEY_COMMANDS.find((command) => command.id === 'addElement.toggleSnap');
    assert.ok(row, 'addElement.toggleSnap must be in the key table');
    assert.equal(row.when, 'tool.addElement');
    assert.deepEqual(row.keys.map((chord) => chord.key), ['s']);
  });

  it('S turns snapping off and on again while Add Element is active', () => {
    render(<Harness />);
    press(window, 's');
    assert.equal(useViewerStore.getState().snapEnabled, false);
    press(window, 's');
    assert.equal(useViewerStore.getState().snapEnabled, true);
  });

  it('S does nothing to snapping in the Select tool (control)', () => {
    useViewerStore.setState({ activeTool: 'select' });
    render(<Harness />);
    press(window, 's');
    assert.equal(useViewerStore.getState().snapEnabled, true);
  });

  it('typing S into a panel field does not toggle snapping', () => {
    render(<Harness />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press(input, 's');
    assert.equal(useViewerStore.getState().snapEnabled, true);
  });
});
