/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stepping between cutting planes from the keyboard (#7545): `,` and `.` in the Section tool select
 * the previous and next plane in the order of the chips, wrapping, and do nothing in any other tool
 * or with fewer than two planes.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

function Host() { useKeyboardShortcuts(); return null; }

function press(key: string): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(event); });
  return event;
}
const state = () => useViewerStore.getState();

beforeEach(() => {
  state().resetViewerState();
  render(<Host />);
  act(() => { state().setActiveTool('section'); state().addSectionPlane('down'); state().addSectionPlane('side'); state().addSectionPlane('front'); });
});
afterEach(cleanup);

describe('section plane stepping keys (#7545)', () => {
  it('"." moves to the next plane in chip order and wraps; "," goes back', () => {
    assert.equal(state().sectionPlane.name, 'C');
    press('.');
    assert.equal(state().sectionPlane.name, 'A', 'wraps past the last');
    press('.');
    assert.equal(state().sectionPlane.name, 'B');
    press(',');
    press(',');
    assert.equal(state().sectionPlane.name, 'C', 'wraps the other way');
  });

  it('does nothing outside the Section tool, and leaves the key alone', () => {
    act(() => state().setActiveTool('select'));
    const event = press('.');
    assert.equal(state().sectionPlane.name, 'C');
    assert.equal(event.defaultPrevented, false);
  });

  it('does nothing with a single plane', () => {
    act(() => { state().clearSectionPlanes(); state().addSectionPlane('down'); });
    press('.');
    assert.equal(state().sectionPlane.name, 'A');
  });
});
