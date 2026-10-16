/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.viewer` with several cutting planes (#7545), through the real store: the adapter reports
 * every plane that is on, replaces or extends the set, names planes by id for removal, and the
 * single-plane methods keep meaning "the active plane".
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store/index.js';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

const store = { getState: () => useViewerStore.getState(), setState: useViewerStore.setState } as unknown as StoreApi;
const viewer = () => createViewerAdapter(store);
const state = () => useViewerStore.getState();
const strip = (planes: Array<{ axis: string; position: number; flipped: boolean }>) => planes.map(({ axis, position, flipped }) => ({ axis, position, flipped }));

beforeEach(() => state().resetViewerState());

const THREE = [
  { axis: 'y', position: 40, enabled: true, flipped: false },
  { axis: 'x', position: 70, enabled: true, flipped: true },
  { axis: 'z', position: 25, enabled: true, flipped: false },
] as const;

describe('bim.viewer sections (#7545)', () => {
  it('setSections replaces every plane; getSections reports them, the first active, with ids', () => {
    const v = viewer();
    v.setSections!([...THREE]);
    const back = v.getSections!();
    assert.deepEqual(strip(back), THREE.map(({ axis, position, flipped }) => ({ axis, position, flipped })));
    assert.equal(new Set(back.map((p) => p.id)).size, 3, 'each plane has its own id');
    assert.ok(back.every((p) => typeof p.name === 'string' && p.name.length > 0));
    assert.equal(state().sectionPlane.id, back[0]!.id, 'the first plane is the active one');
    assert.equal(state().activeTool, 'section', 'a cut handed over is shown');

    // Replace, not extend.
    v.setSections!([THREE[1]]);
    assert.equal(v.getSections!().length, 1);
  });

  it('a section box is not reported as a plane', () => {
    const v = viewer();
    v.setSections!([THREE[0], THREE[1]]);
    state().setSectionBox({ min: [0, 0, 0], max: [1, 1, 1] }); // the active plane becomes a box
    assert.equal(v.getSections!().length, 1, 'only the real plane');
  });

  it('a plane that is not on screen is neither reported nor accepted; an empty list clears everything', () => {
    const v = viewer();
    v.setSections!([THREE[0], { ...THREE[1], enabled: false }, THREE[2]]);
    assert.equal(v.getSections!().length, 2);
    v.setSections!([]);
    assert.deepEqual(v.getSections!(), []);
    assert.equal(v.getSection(), null);
  });

  it('addSection returns an id that removeSection takes, once', () => {
    const v = viewer();
    v.setSections!([THREE[0]]);
    const id = v.addSection!(THREE[1]);
    assert.ok(id);
    assert.deepEqual(v.getSections!().map((p) => p.id).includes(id), true);
    assert.equal(v.getSections!().length, 2);
    assert.equal(v.removeSection!(id), true);
    assert.equal(v.getSections!().length, 1);
    assert.equal(v.removeSection!(id), false, 'it is gone');
    assert.equal(v.removeSection!('no-such-plane'), false);
  });

  it('at the limit addSection says so instead of replacing', () => {
    const v = viewer();
    v.setSections!(Array.from({ length: 8 }, (_, i) => ({ axis: 'y' as const, position: 10 + i * 10, enabled: true, flipped: false })));
    assert.equal(v.getSections!().length, 8);
    assert.equal(v.addSection!(THREE[0]), null);
    assert.equal(v.getSections!().length, 8);
  });

  it('getSection and setSection still mean the active plane', () => {
    const v = viewer();
    v.setSections!([...THREE]);
    assert.equal(v.getSection()?.axis, 'y', 'the active plane');
    v.setSection({ axis: 'z', position: 60, enabled: true, flipped: false });
    assert.equal(v.getSections!().length, 1, 'setSection is THE cut, as before');
  });
});
