/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The alignment picker with several cutting planes (#7545): it belongs to the plane that was active
 * when it was opened. Choosing another plane must close it, or the next axis chosen would rebind
 * the plane that was just selected.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { chooseAlignmentMode, startAlignmentTool, useAlignmentToolState } from './alignment-controller.js';

const state = () => useViewerStore.getState();
let stop: (() => void) | null = null;

beforeEach(() => {
  state().resetViewerState();
  useAlignmentToolState.setState({ choosing: false, busy: false });
  stop = startAlignmentTool();
});
afterEach(() => { stop?.(); stop = null; });

describe('alignment picker and the active plane (#7545)', () => {
  it('closes when another plane is chosen', () => {
    state().setActiveTool('section');
    const a = state().addSectionPlane('down')!;
    state().addSectionPlane('side');
    chooseAlignmentMode();
    assert.equal(useAlignmentToolState.getState().choosing, true);
    state().activateSectionPlane(a);
    assert.equal(useAlignmentToolState.getState().choosing, false, 'plane A does not inherit the picker opened for plane B');
  });

  it('stays open while its own plane is edited', () => {
    state().setActiveTool('section');
    state().addSectionPlane('down');
    chooseAlignmentMode();
    state().setSectionPlanePosition(30);
    assert.equal(useAlignmentToolState.getState().choosing, true);
  });
});
