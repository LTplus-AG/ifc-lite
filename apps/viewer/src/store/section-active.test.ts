/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sectionPlane.enabled` is the cut ON SCREEN (#4910).
 *
 * The renderer draws the cut only while the Section tool is active. Leaving
 * the tool used to keep `enabled: true`, so the SDK, the PDF export and BCF
 * saw a cut the user could not see (verified on production 2026-09-17). These
 * tests drive the real store through its actions only.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';
import { activeSectionPlane } from './section-active.js';

function state() {
  return useViewerStore.getState();
}

beforeEach(() => {
  state().setActiveTool('select');
  state().setSectionPlaneEnabled(false);
  useViewerStore.setState({
    sectionPlane: { ...state().sectionPlane, axis: 'down', position: 50, flipped: false, custom: undefined },
  });
});

describe('section visibility invariant (#4910)', () => {
  it('leaving the Section tool turns the cut off in the store, not just on screen', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setSectionPlanePosition(30);
    assert.equal(state().sectionPlane.enabled, true, 'the cut is on screen inside the tool');

    state().setActiveTool('select');
    assert.equal(state().sectionPlane.enabled, false, 'BUG: enabled outlived the Section tool');
    assert.equal(activeSectionPlane(state()), null);
  });

  it('reopening the Section tool restores the last cut, face-picked planes included', () => {
    state().setActiveTool('section');
    state().setSectionPlaneFromFace([0, 1, 0], [0, 2, 0]);
    state().setSectionShowCap(false);
    const cut = state().sectionPlane.custom;
    assert.ok(cut, 'the face pick made a custom plane');

    state().setActiveTool('measure');
    state().setActiveTool('section');
    const plane = state().sectionPlane;
    assert.equal(plane.enabled, true, 'the cut must come back when the tool reopens');
    assert.deepEqual(plane.custom, cut, 'the same face-picked plane');
    assert.equal(plane.showCap, false, 'cap settings are untouched by leaving the tool');
  });

  it('turning a face-picked cut off inside the tool stays off after leaving and reopening', () => {
    // (A cardinal cut is re-applied by SectionPanel from the last-used mode on mount.)
    state().setActiveTool('section');
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    state().toggleSectionPlane();
    state().setActiveTool('select');
    state().setActiveTool('section');
    assert.equal(state().sectionPlane.enabled, false);
  });

  it('the storey floor-plan flow (cut set before the tool opens) is on screen once it opens', () => {
    // useFloorplanView: axis + position first, then the tool.
    state().setSectionPlaneAxis('down');
    assert.equal(state().sectionPlane.enabled, false, 'not on screen while another tool is active');
    state().setSectionPlanePosition(42);
    state().setActiveTool('section');
    const shown = activeSectionPlane(state());
    assert.ok(shown, 'the floor-plan cut is visible');
    assert.equal(shown.position, 42);
    assert.equal(state().sectionPlane.enabled, true);
  });
});
