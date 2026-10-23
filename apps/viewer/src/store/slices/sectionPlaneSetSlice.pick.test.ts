/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The armed face pick and its target (#7545): "add a plane" must neither disturb the plane that
 * is active, nor outlive the pick that armed it and turn a later, unrelated face cut (an assistant
 * action, a re-armed pick) into an added plane.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '../index.js';
import type { AlignmentSectionBinding } from '@/lib/section/alignment-contract';

const state = () => useViewerStore.getState();
const count = () => 1 + state().inactiveSectionPlanes.length;

beforeEach(() => state().resetViewerState());

describe('arming a pick for a NEW plane (#7545)', () => {
  it('does not detach the active plane from its alignment', () => {
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    const binding = { station: 12 } as unknown as AlignmentSectionBinding;
    useViewerStore.setState({ sectionPlane: { ...state().sectionPlane, custom: { ...state().sectionPlane.custom!, alignment: binding } } });
    assert.ok(state().armSectionFacePickForNewPlane());
    assert.equal(state().sectionPlane.custom?.alignment, binding, 'the active plane keeps its station: this pick adds a plane');
    assert.equal(state().sectionPickTarget, 'new');
  });

  it('adds the plane when the pick commits, once', () => {
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    assert.ok(state().armSectionFacePickForNewPlane());
    state().setSectionPlaneFromFace([0, 1, 0], [0, 2, 0]);
    assert.equal(count(), 2);
    assert.equal(state().sectionPickTarget, 'replace', 'one pick, one plane');
  });
});

describe('a stale "new" target (#7545)', () => {
  it('is not honoured by a face cut that arrives with no pick armed', () => {
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    assert.ok(state().armSectionFacePickForNewPlane());
    // The pick is disarmed by something else (the box tool does this) and leaves the target behind.
    state().setSectionBox({ min: [0, 0, 0], max: [1, 1, 1] });
    assert.equal(state().sectionPickMode, false);
    const before = count();
    state().setSectionPlaneFromFace([0, 0, 1], [0, 0, 4]); // an assistant's face cut
    assert.equal(count(), before, 'it replaces the active plane; it does not add one');
  });

  it('is reset when the pick is armed the plain way', () => {
    state().setSectionPlaneFromFace([1, 0, 0], [3, 0, 0]);
    assert.ok(state().armSectionFacePickForNewPlane());
    state().setSectionBox({ min: [0, 0, 0], max: [1, 1, 1] });
    state().setSectionPickMode(true);
    assert.equal(state().sectionPickTarget, 'replace');
  });

  it('is cleared by a degenerate pick', () => {
    assert.ok(state().armSectionFacePickForNewPlane());
    state().setSectionPlaneFromFace([0, 0, 0], [1, 1, 1]); // a zero normal
    assert.equal(state().sectionPickMode, false);
    assert.equal(state().sectionPickTarget, 'replace');
  });
});
