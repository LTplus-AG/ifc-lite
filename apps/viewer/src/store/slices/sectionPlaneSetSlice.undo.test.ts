/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo of Remove / Clear all (#7545) gives back the planes the removal took out and leaves every
 * other change alone: the toast stays up for seconds, and the user keeps working meanwhile.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '../index.js';
import { orderedSectionPlanes } from '@/lib/section/section-plane-set';

const state = () => useViewerStore.getState();
const set = () => orderedSectionPlanes(state().sectionPlane, state().inactiveSectionPlanes);
const names = () => set().map((p) => p.name);

beforeEach(() => {
  state().resetViewerState();
  state().setActiveTool('section');
});

function three() {
  state().addSectionPlane('down');
  const b = state().addSectionPlane('side')!;
  const c = state().addSectionPlane('front')!;
  return { b, c };
}

describe('Undo after Remove (#7545)', () => {
  it('brings the plane back and does not revert what was done since', () => {
    const { b, c } = three();
    state().removeSectionPlane(b);
    assert.deepEqual(names(), ['A', 'C']);
    // Work continues: C is edited and activated while the toast is still up.
    state().activateSectionPlane(c);
    state().setSectionPlanePosition(77);
    state().undoSectionChange();
    assert.deepEqual(names(), ['A', 'B', 'C'], 'B is back, in its place');
    assert.equal(set().find((p) => p.name === 'C')!.position, 77, 'C keeps the edit made after the removal');
    assert.equal(state().sectionPlane.id, c, 'the plane the user is working on stays active');
  });

  it('a plane made since does not collide with the name of the one restored', () => {
    const { b } = three();
    state().removeSectionPlane(b);
    state().addSectionPlane('down'); // takes the first free name: "B"
    assert.deepEqual(names(), ['A', 'C', 'B'], 'the new plane took the first free name, B');
    state().undoSectionChange();
    const all = names();
    assert.equal(new Set(all.map((n) => n.toLowerCase())).size, all.length, `names stay unique: ${all}`);
    assert.equal(all.length, 4);
  });

  it('with no room left it restores nothing and says no more about it', () => {
    const { b } = three();
    state().removeSectionPlane(b);
    for (let i = 0; i < 8; i++) state().addSectionPlane('down');
    assert.equal(set().length, 8);
    state().undoSectionChange();
    assert.equal(set().length, 8);
    assert.equal(state().sectionUndo, null);
  });
});

describe('Undo after Clear all (#7545)', () => {
  it('restores the whole set, as before', () => {
    three();
    const before = set();
    state().clearSectionPlanes();
    state().undoSectionChange();
    assert.deepEqual(set(), before);
  });

  it('merges with planes made after the clear instead of replacing them', () => {
    three();
    state().clearSectionPlanes();
    state().addSectionPlane('side');
    assert.deepEqual(names(), ['A']);
    state().undoSectionChange();
    assert.equal(set().length, 4, 'the three cleared planes and the one added since');
    assert.equal(new Set(names().map((n) => n.toLowerCase())).size, 4);
  });
});
