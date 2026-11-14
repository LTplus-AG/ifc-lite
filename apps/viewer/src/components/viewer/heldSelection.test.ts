/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { deferSelectionFrameWhileHeld, viewportSelection } from './heldSelection.js';

const selected = new Set([42]);
const state = (held: boolean) => ({ geometryStreamingActive: false, loading: false, progress: null,
  models: new Map([['m', { geometryRestorePending: held }]]) });

describe('tree selection while geometry restore is held', () => {
  it('keeps ID-based selection in state and applies the 3D highlight on release', () => {
    const duringHold = viewportSelection(state(true), 42, selected);
    assert.equal(duringHold.selectedId, null);
    assert.equal(duringHold.selectedIds.size, 0);
    assert.deepEqual([...selected], [42], 'tree/property ID selection stays intact');

    const afterRelease = viewportSelection(state(false), 42, selected);
    assert.equal(afterRelease.selectedId, 42);
    assert.strictEqual(afterRelease.selectedIds, selected);
  });

  it('defers tree-driven zoom until release while leaving ID selection available', () => {
    const framed: (number | undefined)[] = [];
    useViewerStore.getState().resetViewerState();
    useViewerStore.setState({ models: new Map([['m', { geometryRestorePending: true, loadState: 'complete' }]]) as never,
      selectedEntityId: 42, selectedEntityIds: selected, cameraCallbacks: { frameSelection: (duration) => { framed.push(duration); } } });
    assert.equal(deferSelectionFrameWhileHeld(500), true);
    assert.equal(useViewerStore.getState().selectedEntityIds.has(42), true);
    assert.deepEqual(framed, []);

    useViewerStore.setState({ models: new Map([['m', { geometryRestorePending: false, loadState: 'complete' }]]) as never });
    assert.deepEqual(framed, [500]);
    useViewerStore.getState().resetViewerState();
  });

  it('#10218 releases a deferred frame according to its selected model restore', () => {
    const framed: (number | undefined)[] = [];
    const reset = () => useViewerStore.getState().resetViewerState();
    reset();
    const setModels = (aPending: boolean, aLoad: string, bPending: boolean, bLoad: string) => {
      useViewerStore.setState({ models: new Map([
        ['A', { geometryRestorePending: aPending, loadState: aLoad }],
        ['B', { geometryRestorePending: bPending, loadState: bLoad }],
      ]) as never });
    };

    setModels(true, 'pending', true, 'pending');
    useViewerStore.setState({ selectedEntity: { modelId: 'A', expressId: 42 } as never,
      cameraCallbacks: { frameSelection: (duration) => { framed.push(duration); } } });
    assert.equal(deferSelectionFrameWhileHeld(500), true);
    setModels(false, 'complete', false, 'error');
    assert.equal(framed.length, 1, 'A completes even if B fails');
    assert.equal(framed[0], 500);

    reset(); framed.length = 0;
    setModels(true, 'pending', true, 'pending');
    useViewerStore.setState({ selectedEntity: { modelId: 'A', expressId: 42 } as never,
      cameraCallbacks: { frameSelection: (duration) => { framed.push(duration); } } });
    assert.equal(deferSelectionFrameWhileHeld(600), true);
    setModels(false, 'error', false, 'complete');
    assert.equal(framed.length, 0, 'A failure drops its frame');

    reset(); framed.length = 0;
    setModels(true, 'pending', true, 'pending');
    useViewerStore.setState({ selectedEntity: { modelId: 'A', expressId: 42 } as never,
      cameraCallbacks: { frameSelection: (duration) => { framed.push(duration); } } });
    assert.equal(deferSelectionFrameWhileHeld(700), true);
    setModels(true, 'pending', false, 'error');
    assert.equal(framed.length, 0, 'A still restoring keeps the frame queued');
    setModels(false, 'complete', false, 'error');
    assert.equal(framed.length, 1, 'A completion releases the queued frame');
    assert.equal(framed[0], 700);
    reset();
  });
});
