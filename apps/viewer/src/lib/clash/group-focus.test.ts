/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { focusClashGroup } from './group-focus.js';

function clash(id: string, a: number, b: number): Clash {
  return {
    id,
    a: { key: `${id}-a`, ref: a, model: 'model', tag: 'IfcWall' },
    b: { key: `${id}-b`, ref: b, model: 'model', tag: 'IfcPipeSegment' },
    rule: 'all', status: 'hard', distance: -0.1, point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
  };
}

describe('manual clash group focus (#4921)', () => {
  beforeEach(() => {
    useViewerStore.getState().clearEntitySelection();
    useViewerStore.setState({ cameraCallbacks: {}, lensAppliedColors: new Map() });
  });

  it('selects every distinct object through its model ref and applies one focus operation', async () => {
    const applyFocusMode = mock.fn();
    const frameSelection = mock.fn();
    useViewerStore.setState({ cameraCallbacks: { frameSelection } });
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref + 100 });

    focusClashGroup([clash('c1', 10, 20), clash('c2', 20, 30)], resolve, applyFocusMode, 'ghost');

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, new Set([10, 20, 30]));
    assert.deepEqual(state.selectedEntitiesSet, new Set(['model:110', 'model:120', 'model:130']));
    assert.equal(applyFocusMode.mock.callCount(), 1);
    assert.deepEqual(applyFocusMode.mock.calls[0].arguments, [[10, 20, 30], 'ghost']);
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    assert.equal(frameSelection.mock.callCount(), 1);
  });

  it('ignores unresolvable objects and leaves selection untouched when none resolve', () => {
    useViewerStore.getState().setSelectedEntityIds([99]);
    const applyFocusMode = mock.fn();

    focusClashGroup([clash('c1', 10, 20)], () => null, applyFocusMode, 'isolate');

    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([99]));
    assert.equal(applyFocusMode.mock.callCount(), 0);
  });
});
