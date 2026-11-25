/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CAD-style corner snapping, viewer side (#11504): X-ray state to snap options
 * and to the ghost channel, and the marker list the overlay draws. Pure rules,
 * so no renderer or WebGPU is involved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ScreenCornerMarkers } from '@ifc-lite/renderer';
import {
  cornerMarkerViews, effectiveGhostExcept, isSnapPicking, isSnapXrayActive, screenCornerSnapConfig,
} from './corner-assist';
import { createSnapAssistSlice, type SnapAssistSlice } from '../../store/slices/snapAssistSlice';

function slice(): { get: () => SnapAssistSlice } {
  let state = {} as SnapAssistSlice;
  state = createSnapAssistSlice((fn) => { state = { ...state, ...fn(state) }; });
  return { get: () => state };
}

describe('X-ray state to snap options', () => {
  it('turns the occlusion rule off only with X-ray, and always asks for markers', () => {
    assert.deepEqual(screenCornerSnapConfig(false), { markers: true });
    assert.deepEqual(screenCornerSnapConfig(true), { markers: true, ignoreOcclusion: true });
    assert.equal('ignoreOcclusion' in screenCornerSnapConfig(false), false, 'unset, not false: the default applies');
  });

  it('the toggle drives the option and back', () => {
    const store = slice();
    assert.equal(store.get().snapXray, false, 'off by default');
    const options = () => screenCornerSnapConfig(store.get().snapXray);
    assert.equal(options().ignoreOcclusion, undefined);
    store.get().toggleSnapXray();
    assert.equal(options().ignoreOcclusion, true);
    store.get().toggleSnapXray();
    assert.equal(options().ignoreOcclusion, undefined);
  });
});

describe('where X-ray applies', () => {
  const state = (over: Partial<{ activeTool: string; repositionPicking: boolean; snapXray: boolean }>) =>
    ({ activeTool: 'select', repositionPicking: false, snapXray: true, ...over });

  it('applies in Measure and in an armed Reposition pick, and nowhere else', () => {
    assert.equal(isSnapXrayActive(state({ activeTool: 'measure' })), true);
    assert.equal(isSnapXrayActive(state({ repositionPicking: true })), true);
    assert.equal(isSnapXrayActive(state({})), false, 'Select tool, nothing armed');
    assert.equal(isSnapXrayActive(state({ activeTool: 'command' })), false, 'a modeling command is not offered the toggle');
    assert.equal(isSnapXrayActive(state({ activeTool: 'measure', snapXray: false })), false);
  });

  it('markers are for the three snapping pickers', () => {
    assert.equal(isSnapPicking(state({ activeTool: 'measure' })), true);
    assert.equal(isSnapPicking(state({ activeTool: 'command' })), true);
    assert.equal(isSnapPicking(state({ repositionPicking: true })), true);
    assert.equal(isSnapPicking(state({ activeTool: 'section' })), false);
  });

  it('the Reposition flag is set and cleared by the slice', () => {
    const store = slice();
    store.get().setRepositionPicking(true);
    assert.equal(store.get().repositionPicking, true);
    store.get().setRepositionPicking(false);
    assert.equal(store.get().repositionPicking, false);
  });
});

describe('X-ray appearance', () => {
  it('ghosts everything while active and gives back the stored channel, unchanged, afterwards', () => {
    const stored = new Set([7, 8]);
    const ghosted = effectiveGhostExcept(true, stored);
    assert.ok(ghosted && ghosted.size === 0, 'every entity is outside the (empty) exception set, so all render translucent');
    assert.equal(effectiveGhostExcept(false, stored), stored, 'the same set object: nothing was written or copied');
    assert.equal(effectiveGhostExcept(false, null), null, 'no ghosting before, none after');
    assert.deepEqual([...stored], [7, 8], 'the owner\'s set is never mutated');
  });

  it('is derived, so toggling off restores exactly the state the store holds', () => {
    const store = slice();
    const stored = new Set([1]);
    const tool = { activeTool: 'measure', repositionPicking: false };
    const view = () => effectiveGhostExcept(isSnapXrayActive({ ...tool, snapXray: store.get().snapXray }), stored);
    assert.equal(view(), stored);
    store.get().toggleSnapXray();
    assert.notEqual(view(), stored);
    store.get().toggleSnapXray();
    assert.equal(view(), stored);
  });
});

describe('marker list derivation', () => {
  const cand = (x: number, y: number, id: number) => ({ screen: { x, y }, position: { x, y, z: 0 }, expressId: id, distancePx: 0 });
  const markers = (activeIndex: number): ScreenCornerMarkers => ({ viewKey: 'v', activeIndex, candidates: [cand(10, 10, 1), cand(20, 20, 2), cand(30, 30, 3)] });

  it('lists every candidate at its screen position, the active one last so it draws on top', () => {
    const views = cornerMarkerViews(markers(0), 'v');
    assert.equal(views.length, 3);
    assert.deepEqual(views.map((v) => v.active), [false, false, true]);
    assert.deepEqual(views[2], { key: views[2].key, x: 10, y: 10, active: true });
    assert.equal(new Set(views.map((v) => v.key)).size, 3, 'unique keys');
  });

  it('marks none active when the pick used none of the corners', () => {
    assert.ok(cornerMarkerViews(markers(-1), 'v').every((v) => !v.active));
  });

  it('draws nothing once the view differs from the one the corners were projected under', () => {
    assert.deepEqual(cornerMarkerViews(markers(0), 'moved'), []);
    assert.deepEqual(cornerMarkerViews(markers(0), null), []);
    assert.deepEqual(cornerMarkerViews(null, 'v'), []);
  });
});
