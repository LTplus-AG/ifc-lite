/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved section cuts (#5514): applying one must re-enter the Section/Drawing
 * contract exactly like every other section writer, so BCF viewpoint capture
 * and the floor-plan command — both of which just read `sectionPlane` /
 * `activeSectionPlane()` — see it without any code of their own.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';
import { activeSectionPlane } from './section-active.js';
import {
  applySavedSectionCut,
  removeSavedSectionCut,
  renameSavedSectionCut,
  saveCurrentSectionCut,
  useSavedSectionCuts,
} from './savedSectionCutsStore.js';

function state() {
  return useViewerStore.getState();
}

beforeEach(() => {
  state().setActiveTool('select');
  state().setSectionPlaneEnabled(false);
  useViewerStore.setState({
    sectionPlane: { ...state().sectionPlane, axis: 'down', position: 50, flipped: false, custom: undefined },
  });
  useSavedSectionCuts.setState({ cuts: [], activeCutId: null });
});

describe('saved section cuts (#5514)', () => {
  it('saves the live cut and restores it exactly, reopening the Section tool', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setSectionPlanePosition(37);
    state().flipSectionPlane();
    const id = saveCurrentSectionCut('Front @ level 2');

    // Move the live cut elsewhere and leave the tool — the saved cut must
    // still describe the ORIGINAL geometry, not whatever is live now.
    state().setSectionPlaneAxis('down');
    state().setSectionPlanePosition(10);
    state().setActiveTool('select');
    assert.equal(activeSectionPlane(state()), null, 'no cut on screen outside the tool');

    applySavedSectionCut(id);

    const plane = state().sectionPlane;
    assert.equal(plane.axis, 'front');
    assert.equal(plane.position, 37);
    assert.equal(plane.flipped, true);
    assert.equal(state().activeTool, 'section', 'applying a saved cut opens the Section tool');
    const shown = activeSectionPlane(state());
    assert.ok(shown, 'the saved cut is visible, exactly like any other section writer');
    assert.equal(useSavedSectionCuts.getState().activeCutId, id);
  });

  it('restores a face-picked (custom) plane bit for bit', () => {
    state().setActiveTool('section');
    state().setSectionPlaneFromFace([0, 1, 0], [0, 2, 0]);
    const custom = state().sectionPlane.custom;
    assert.ok(custom, 'the face pick made a custom plane');
    const id = saveCurrentSectionCut('Face pick');

    state().setSectionPlaneAxis('side'); // drops `custom`
    assert.equal(state().sectionPlane.custom, undefined);

    applySavedSectionCut(id);
    assert.deepEqual(state().sectionPlane.custom, custom);
  });

  it('rename updates the name only; delete drops the cut and clears activeCutId', () => {
    const id = saveCurrentSectionCut('Original name');
    renameSavedSectionCut(id, 'Renamed');
    assert.equal(useSavedSectionCuts.getState().cuts[0]?.name, 'Renamed');

    applySavedSectionCut(id);
    assert.equal(useSavedSectionCuts.getState().activeCutId, id);

    removeSavedSectionCut(id);
    assert.equal(useSavedSectionCuts.getState().cuts.length, 0);
    assert.equal(useSavedSectionCuts.getState().activeCutId, null, 'removing the active cut clears the pointer');
  });

  it('a blank rename is rejected, keeping the original name', () => {
    const id = saveCurrentSectionCut('Keep me');
    renameSavedSectionCut(id, '   ');
    assert.equal(useSavedSectionCuts.getState().cuts[0]?.name, 'Keep me');
  });

  it('applying a saved plane cut leaves section box mode, so the plane is the cut (#5513)', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    const id = saveCurrentSectionCut('Front');
    state().setSectionBox({ min: [0, 0, 0], max: [4, 3, 2] });
    assert.ok(state().sectionPlane.box, 'in box mode');
    applySavedSectionCut(id);
    assert.equal(state().sectionPlane.box, undefined, 'the box is gone');
    assert.equal(activeSectionPlane(state())?.axis, 'front');
  });

  it('applying an unknown id is a no-op', () => {
    const before = state().sectionPlane;
    applySavedSectionCut('does-not-exist');
    assert.deepEqual(state().sectionPlane, before);
  });
});
