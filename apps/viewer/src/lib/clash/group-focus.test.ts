/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import { useViewerStore, type ViewerState } from '@/store';
import { CLASH_COLOR_A, CLASH_COLOR_B } from './clash-colors.js';
import { focusClashGroup, focusedSceneRevisionIsCurrent, type FocusedClashGroup } from './group-focus.js';

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
    useViewerStore.setState({
      cameraCallbacks: {}, lensAppliedColors: new Map(), models: new Map(),
      hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
      hiddenEntitiesByModel: new Map(), isolatedEntitiesByModel: new Map(), mutationVersion: 0,
      colorPresentationRevision: 0,
    });
  });

  function payload(
    focused: FocusedClashGroup | null,
  ): Omit<FocusedClashGroup, 'sceneRevision' | 'frameReady'> | null {
    if (!focused) return null;
    const { sceneRevision: _sceneRevision, frameReady: _frameReady, ...rest } = focused;
    return rest;
  }

  it('selects every distinct object through its model ref and applies one focus operation', async () => {
    const applyFocusMode = mock.fn();
    const frameSelection = mock.fn();
    useViewerStore.setState({ cameraCallbacks: { frameSelection } });
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref + 100 });

    assert.deepEqual(
      payload(focusClashGroup([clash('c1', 10, 20), clash('c2', 20, 30)], resolve, applyFocusMode, 'ghost')),
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
    assert.deepEqual(state.clashHighlightColors, new Map([
      [110, CLASH_COLOR_A], [120, CLASH_COLOR_A], [130, CLASH_COLOR_B],
    ]), 'the rendered group uses the same deterministic A/B colors serialized into BCF');
    assert.deepEqual(state.pendingColorUpdates, state.clashHighlightColors);
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
    assert.ok(focused);
    useViewerStore.setState({
      models: new Map([
        ['model', { idOffset: 0, ifcDataStore: { entities: { getGlobalId: () => 'REPLACED' } } }],
      ]) as unknown as ViewerState['models'],
    });
    assert.deepEqual(payload(focused), {
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
    assert.equal(focusedSceneRevisionIsCurrent(focused), false,
      'a replacement during the frame wait must invalidate the focused scene');

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, new Set([10, 20, 30]));
    assert.ok(state.selectedEntitiesSet.has('model:10'));
    assert.ok(state.selectedEntitiesSet.has('room:r:m0:10'));
  });

  it('serializes the color the renderer can show when model refs share one numeric id', () => {
    const crossModel = clash('cross-model', 10, 10);
    crossModel.b.model = 'room:r:m0';
    useViewerStore.setState({
      models: new Map([
        ['model', {
          idOffset: 0,
          ifcDataStore: { entities: { getGlobalId: () => 'MODEL-A' } },
        }],
        ['room:r:m0', {
          idOffset: 0,
          ifcDataStore: { entities: { getGlobalId: () => 'ROOM-B' } },
        }],
      ]) as unknown as ViewerState['models'],
    });

    const focused = focusClashGroup(
      [crossModel],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.deepEqual(focused.aGuids, ['MODEL-A', 'ROOM-B']);
    assert.deepEqual(focused.bGuids, [],
      'the BCF coloring must not claim cyan for a renderer id painted amber');
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([[10, CLASH_COLOR_A]]));
  });

  it('returns viewpoint refs only for objects that resolved in the current models', () => {
    const current = clash('current', 10, 20);
    const stale = clash('stale', 30, 40);
    stale.a.model = 'replaced';
    stale.b.model = 'replaced';
    const resolve = (element: ClashElementRef) =>
      element.model === 'replaced' ? null : { modelId: element.model, expressId: element.ref };

    assert.deepEqual(payload(focusClashGroup([current, stale], resolve, mock.fn(), 'highlight')), {
      selectedRefs: [{ modelId: 'model', expressId: 10 }, { modelId: 'model', expressId: 20 }],
      aRefs: [{ modelId: 'model', expressId: 10 }],
      bRefs: [{ modelId: 'model', expressId: 20 }],
      selectedGuids: [], aGuids: [], bGuids: [],
      modelIds: ['model'],
    });
  });

  it('invalidates a focused frame when authored IFC or visibility changes while capture waits', () => {
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref });
    const beforeMutation = focusClashGroup([clash('mutation', 10, 20)], resolve, mock.fn(), 'ghost');
    assert.ok(beforeMutation);
    useViewerStore.setState({ mutationVersion: 1 });
    assert.equal(focusedSceneRevisionIsCurrent(beforeMutation), false);

    const beforeVisibility = focusClashGroup([clash('visibility', 10, 20)], resolve, mock.fn(), 'ghost');
    assert.ok(beforeVisibility);
    useViewerStore.setState({ hiddenEntities: new Set([99]) });
    assert.equal(focusedSceneRevisionIsCurrent(beforeVisibility), false);
  });

  it('invalidates capture when another selection or presentation replaces the focused group', () => {
    const resolve = (element: ClashElementRef) => ({ modelId: element.model, expressId: element.ref });
    const beforeSelection = focusClashGroup([clash('selection', 10, 20)], resolve, mock.fn(), 'highlight');
    assert.ok(beforeSelection);
    useViewerStore.getState().setSelectedEntityIds([99]);
    assert.equal(focusedSceneRevisionIsCurrent(beforeSelection), false);

    const beforePresentation = focusClashGroup([clash('presentation', 10, 20)], resolve, mock.fn(), 'highlight');
    assert.ok(beforePresentation);
    useViewerStore.getState().setClashHighlightColors(new Map([[99, CLASH_COLOR_A]]));
    assert.equal(focusedSceneRevisionIsCurrent(beforePresentation), false);

    const beforePaintFlush = focusClashGroup([clash('paint-flush', 10, 20)], resolve, mock.fn(), 'highlight');
    assert.ok(beforePaintFlush);
    useViewerStore.getState().clearPendingColorUpdates();
    assert.equal(focusedSceneRevisionIsCurrent(beforePaintFlush), true,
      'flushing the one-shot GPU paint signal is part of a normal capture frame');

    const beforeRecolor = focusClashGroup([clash('recolor', 10, 20)], resolve, mock.fn(), 'highlight');
    assert.ok(beforeRecolor);
    useViewerStore.getState().setPendingColorUpdates(new Map([[99, CLASH_COLOR_A]]));
    assert.equal(focusedSceneRevisionIsCurrent(beforeRecolor), false,
      'a new renderer color delivery is a competing presentation even after its queue later flushes');
  });

  it('exposes completion of the actual camera framing animation', async () => {
    let finishFraming!: () => void;
    let requestedDuration: number | undefined;
    useViewerStore.setState({
      cameraCallbacks: {
        frameSelection: (durationMs) => {
          requestedDuration = durationMs;
          return new Promise<void>((resolve) => { finishFraming = resolve; });
        },
      },
    });
    const focused = focusClashGroup(
      [clash('framing', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    let frameReady = false;
    void focused.frameReady.then(() => { frameReady = true; });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(requestedDuration, 1, 'capture uses immediate framing, not the interactive 300 ms animation');
    assert.equal(frameReady, false, 'one animation frame is not the end of camera framing');
    finishFraming();
    await focused.frameReady;
    assert.equal(frameReady, true);
  });
});
