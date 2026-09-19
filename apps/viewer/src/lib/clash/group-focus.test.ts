/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import { useViewerStore, type ViewerState } from '@/store';
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
    useViewerStore.setState({ cameraCallbacks: {}, lensAppliedColors: new Map(), models: new Map() });
  });

  it('selects every distinct object through its model ref and applies one focus operation', async () => {
    const applyFocusMode = mock.fn();
    const frameSelection = mock.fn();
    useViewerStore.setState({ cameraCallbacks: { frameSelection } });
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref + 100 });

    assert.deepEqual(
      focusClashGroup([clash('c1', 10, 20), clash('c2', 20, 30)], resolve, applyFocusMode, 'ghost'),
      {
        selectedRefs: [
          { modelId: 'model', expressId: 110 },
          { modelId: 'model', expressId: 120 },
          { modelId: 'model', expressId: 130 },
        ],
        aRefs: [{ modelId: 'model', expressId: 110 }, { modelId: 'model', expressId: 120 }],
        bRefs: [{ modelId: 'model', expressId: 130 }],
        selectedGuids: [], aGuids: [], bGuids: [],
        modelIds: ['model'],
      },
    );

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, new Set([110, 120, 130]));
    assert.deepEqual(state.selectedEntitiesSet, new Set(['model:110', 'model:120', 'model:130']));
    assert.equal(applyFocusMode.mock.callCount(), 1);
    assert.deepEqual(applyFocusMode.mock.calls[0].arguments, [[110, 120, 130], 'ghost']);
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    assert.equal(frameSelection.mock.callCount(), 1);
  });

  it('reports when no objects resolve so callers cannot capture an unrelated selection', () => {
    useViewerStore.getState().setSelectedEntityIds([99]);
    const applyFocusMode = mock.fn();

    assert.equal(focusClashGroup([clash('c1', 10, 20)], () => null, applyFocusMode, 'isolate'), null);

    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([99]));
    assert.equal(applyFocusMode.mock.callCount(), 0);
  });

  it('keeps equal numeric refs from distinct models as distinct selections', () => {
    const first = clash('first', 10, 20);
    const second = clash('second', 10, 30);
    second.a.model = 'room:r:m0';
    useViewerStore.setState({
      models: new Map([
        ['model', {
          idOffset: 0,
          ifcDataStore: { entities: { getGlobalId: (id: number) => `MODEL-${id}` } },
        }],
        ['room:r:m0', {
          idOffset: 0,
          ifcDataStore: { entities: { getGlobalId: (id: number) => `ROOM-${id}` } },
        }],
      ]) as unknown as ViewerState['models'],
    });
    const applyFocusMode = mock.fn();
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref });

    const focused = focusClashGroup([first, second], resolve, applyFocusMode, 'highlight');
    useViewerStore.setState({
      models: new Map([
        ['model', { idOffset: 0, ifcDataStore: { entities: { getGlobalId: () => 'REPLACED' } } }],
      ]) as unknown as ViewerState['models'],
    });
    assert.deepEqual(focused, {
      selectedRefs: [
        { modelId: 'model', expressId: 10 },
        { modelId: 'model', expressId: 20 },
        { modelId: 'room:r:m0', expressId: 10 },
        { modelId: 'model', expressId: 30 },
      ],
      aRefs: [{ modelId: 'model', expressId: 10 }, { modelId: 'room:r:m0', expressId: 10 }],
      bRefs: [{ modelId: 'model', expressId: 20 }, { modelId: 'model', expressId: 30 }],
      selectedGuids: ['MODEL-10', 'MODEL-20', 'ROOM-10', 'MODEL-30'],
      aGuids: ['MODEL-10', 'ROOM-10'],
      bGuids: ['MODEL-20', 'MODEL-30'],
      modelIds: ['model', 'room:r:m0'],
    });

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, new Set([10, 20, 30]));
    assert.ok(state.selectedEntitiesSet.has('model:10'));
    assert.ok(state.selectedEntitiesSet.has('room:r:m0:10'));
  });

  it('returns viewpoint refs only for objects that resolved in the current models', () => {
    const current = clash('current', 10, 20);
    const stale = clash('stale', 30, 40);
    stale.a.model = 'replaced';
    stale.b.model = 'replaced';
    const resolve = (element: ClashElementRef) =>
      element.model === 'replaced' ? null : { modelId: element.model, expressId: element.ref };

    assert.deepEqual(focusClashGroup([current, stale], resolve, mock.fn(), 'highlight'), {
      selectedRefs: [{ modelId: 'model', expressId: 10 }, { modelId: 'model', expressId: 20 }],
      aRefs: [{ modelId: 'model', expressId: 10 }],
      bRefs: [{ modelId: 'model', expressId: 20 }],
      selectedGuids: [], aGuids: [], bGuids: [],
      modelIds: ['model'],
    });
  });
});
