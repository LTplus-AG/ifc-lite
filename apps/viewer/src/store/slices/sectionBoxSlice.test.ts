/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box in the store (#5513): one cut at a time — entering box
 * mode drops a face-picked plane, a cardinal axis or a face pick drops the
 * box — a face drag is clamped by its opposite face, and the last-used
 * mode records box mode without persisting the (model-relative) box.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, type StoreApi } from 'zustand';
import { createSectionSlice, loadLastSectionMode, type SectionSlice } from './sectionSlice.js';
import { MIN_SECTION_BOX_SIZE_M } from '@/lib/section/section-box';

const box = () => ({ min: [0, -1, 0] as [number, number, number], max: [10, 3, 8] as [number, number, number] });

let store: StoreApi<SectionSlice>;
beforeEach(() => {
  window.localStorage.clear();
  store = create<SectionSlice>()(createSectionSlice);
});

describe('setSectionBox', () => {
  it('turns the cut on with the box, copying the corners rather than aliasing the caller\'s arrays', () => {
    const input = box();
    store.getState().setSectionBox(input);
    const plane = store.getState().sectionPlane;
    assert.equal(plane.enabled, true);
    assert.deepEqual(plane.box, box());
    input.max[0] = 99;
    assert.equal(plane.box?.max[0], 10, 'the store holds its own copy');
  });

  it('drops a face-picked plane and disarms the pick: one cut at a time', () => {
    store.getState().setSectionPlaneFromFace([1, 0, 0], [2, 0, 0]);
    store.getState().setSectionPickMode(true);
    assert.ok(store.getState().sectionPlane.custom);
    store.getState().setSectionBox(box());
    assert.equal(store.getState().sectionPlane.custom, undefined);
    assert.equal(store.getState().sectionPickMode, false);
  });

  it('records box mode as the last-used mode without the box itself', () => {
    store.getState().setSectionBox(box());
    assert.deepEqual(loadLastSectionMode(), { kind: 'box' });
    assert.equal(window.localStorage.getItem('ifc-lite:section-last-mode'), JSON.stringify({ kind: 'box' }));
  });
});

describe('leaving box mode', () => {
  it('a cardinal axis drops the box', () => {
    store.getState().setSectionBox(box());
    store.getState().setSectionPlaneAxis('front');
    assert.equal(store.getState().sectionPlane.box, undefined);
    assert.equal(store.getState().sectionPlane.axis, 'front');
  });
  it('a face pick drops the box', () => {
    store.getState().setSectionBox(box());
    store.getState().setSectionPlaneFromFace([0, 1, 0], [0, 1, 0]);
    assert.equal(store.getState().sectionPlane.box, undefined);
    assert.ok(store.getState().sectionPlane.custom);
  });
  it('Cut off keeps the box (it is the cut to turn back on)', () => {
    store.getState().setSectionBox(box());
    store.getState().toggleSectionPlane();
    assert.equal(store.getState().sectionPlane.enabled, false);
    assert.deepEqual(store.getState().sectionPlane.box, box());
  });
});

describe('setSectionBoxFace', () => {
  it('moves one face and clamps it against the opposite face', () => {
    store.getState().setSectionBox(box());
    store.getState().setSectionBoxFace('maxY', 1.5);
    assert.deepEqual(store.getState().sectionPlane.box, { min: [0, -1, 0], max: [10, 1.5, 8] });
    store.getState().setSectionBoxFace('minY', 5);
    assert.ok(Math.abs(store.getState().sectionPlane.box!.min[1] - (1.5 - MIN_SECTION_BOX_SIZE_M)) < 1e-12, 'min stops short of max');
  });
  it('is a no-op outside box mode and for a non-finite value', () => {
    const before = store.getState().sectionPlane;
    store.getState().setSectionBoxFace('maxX', 3);
    assert.equal(store.getState().sectionPlane, before);
    store.getState().setSectionBox(box());
    const inBox = store.getState().sectionPlane;
    store.getState().setSectionBoxFace('maxX', NaN);
    assert.equal(store.getState().sectionPlane, inBox);
  });
});
