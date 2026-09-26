/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sectionPlane.enabled` is the cut turned on; `sceneState.section.visible`
 * is the further toggle deciding whether it draws (#4910, #5893).
 *
 * Until #5893, the renderer drew the cut only while the Section tool was
 * active, and leaving the tool forced `sectionPlane.enabled` off — so
 * opening Measure with a cut on screen made it vanish (verified on
 * production 2026-09-17, then again as the #5893 defect: you could not
 * measure inside a section). The cut is now lasting scene state: leaving
 * the Section tool for ANY other tool must not touch `enabled` or
 * `sceneState.section.visible`. These tests drive the real store through
 * its actions only.
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
  state().setSectionVisible(true);
  useViewerStore.setState({
    sectionPlane: { ...state().sectionPlane, axis: 'down', position: 50, flipped: false, custom: undefined },
  });
});

describe('section lasting scene state (#4910, #5893)', () => {
  it('leaving the Section tool for another tool keeps the cut enabled and visible — the renderer keeps receiving the plane', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setSectionPlanePosition(30);
    assert.equal(state().sectionPlane.enabled, true, 'the cut is on screen inside the tool');

    state().setActiveTool('measure');
    assert.equal(state().sectionPlane.enabled, true, 'BUG (pre-#5893): enabled did not survive leaving the Section tool');
    assert.equal(state().sceneState.section.visible, true);
    assert.ok(activeSectionPlane(state()), 'the renderer still receives the plane while Measure is active');

    state().setActiveTool('select');
    assert.equal(state().sectionPlane.enabled, true, 'still on after Select too');
    assert.ok(activeSectionPlane(state()));
  });

  it('the visibility toggle hides the cut without touching `enabled`, independent of the active tool', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setActiveTool('select');
    assert.ok(activeSectionPlane(state()), 'visible by default once defined');

    state().setSectionVisible(false);
    assert.equal(state().sectionPlane.enabled, true, 'the cut itself is not forgotten');
    assert.equal(activeSectionPlane(state()), null, 'the renderer stops receiving the plane');

    state().setSectionVisible(true);
    assert.ok(activeSectionPlane(state()), 'toggling back on restores it');
  });

  it('reopening the Section tool does not, by itself, resume a cut the user explicitly hid', () => {
    state().setActiveTool('section');
    state().setSectionPlaneFromFace([0, 1, 0], [0, 2, 0]);
    state().setSectionShowCap(false);
    const cut = state().sectionPlane.custom;
    assert.ok(cut, 'the face pick made a custom plane');

    state().setActiveTool('measure');
    state().setSectionVisible(false);
    state().setActiveTool('section');
    assert.equal(state().sectionPlane.enabled, true, 'the cut definition is untouched');
    assert.equal(state().sceneState.section.visible, false, 'the tool alone does not un-hide it (#5893 — that is `revealSectionCut`\'s job)');
    assert.deepEqual(state().sectionPlane.custom, cut, 'the same face-picked plane, still remembered');
  });

  it('turning a cut off explicitly stays off after leaving and reopening the tool', () => {
    state().setActiveTool('section');
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    state().toggleSectionPlane();
    assert.equal(state().sectionPlane.enabled, false);
    state().setActiveTool('select');
    state().setActiveTool('section');
    assert.equal(state().sectionPlane.enabled, false, 'no subscription resurrects it on tool reopen (#5893)');
  });

  it('the storey floor-plan flow (cut set before the tool opens) is on screen once it opens', () => {
    // useFloorplanView: axis + position first, then the tool.
    state().setSectionPlaneAxis('down');
    assert.equal(state().sectionPlane.enabled, true, 'setSectionPlaneAxis enables the cut regardless of the active tool (#5893)');
    state().setSectionPlanePosition(42);
    state().setActiveTool('section');
    const shown = activeSectionPlane(state());
    assert.ok(shown, 'the floor-plan cut is visible');
    assert.equal(shown.position, 42);
    assert.equal(state().sectionPlane.enabled, true);
  });
});
