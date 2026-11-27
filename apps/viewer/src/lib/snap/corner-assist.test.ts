/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Corner snap markers, viewer side (#11517): which picks ask for markers and
 * the marker list the overlay draws. Pure rules, so no renderer or WebGPU is
 * involved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ScreenCornerMarkers } from '@ifc-lite/renderer';
import { cornerMarkerViews, isSnapPicking, screenCornerSnapConfig } from './corner-assist';
import { createSnapAssistSlice, type SnapAssistSlice } from '../../store/slices/snapAssistSlice';

function slice(): { get: () => SnapAssistSlice } {
  let state = {} as SnapAssistSlice;
  state = createSnapAssistSlice((fn) => { state = { ...state, ...fn(state) }; });
  return { get: () => state };
}

describe('which picks draw markers', () => {
  const state = (over: Partial<{ activeTool: string; repositionPicking: boolean }>) =>
    ({ activeTool: 'select', repositionPicking: false, ...over });

  it('every snapping pick asks the corner search for markers', () => {
    assert.deepEqual(screenCornerSnapConfig(), { markers: true });
  });

  it('markers are for the three snapping pickers', () => {
    assert.equal(isSnapPicking(state({ activeTool: 'measure' })), true);
    assert.equal(isSnapPicking(state({ activeTool: 'command' })), true);
    assert.equal(isSnapPicking(state({ repositionPicking: true })), true);
    assert.equal(isSnapPicking(state({ activeTool: 'section' })), false);
    assert.equal(isSnapPicking(state({})), false, 'Select tool, nothing armed');
  });

  it('the Reposition flag is set and cleared by the slice', () => {
    const store = slice();
    assert.equal(store.get().repositionPicking, false, 'off by default');
    store.get().setRepositionPicking(true);
    assert.equal(store.get().repositionPicking, true);
    store.get().setRepositionPicking(false);
    assert.equal(store.get().repositionPicking, false);
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
    assert.deepEqual(cornerMarkerViews(markers(-1), 'v').map(v => [v.x, v.y, v.active]), [
      [10, 10, false], [20, 20, false], [30, 30, false],
    ]);
  });

  it('draws nothing once the view differs from the one the corners were projected under', () => {
    assert.deepEqual(cornerMarkerViews(markers(0), 'moved'), []);
    assert.deepEqual(cornerMarkerViews(markers(0), null), []);
    assert.deepEqual(cornerMarkerViews(null, 'v'), []);
  });
});
