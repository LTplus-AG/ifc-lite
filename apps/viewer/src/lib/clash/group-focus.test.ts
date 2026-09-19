/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { CLASH_COLOR_A, CLASH_COLOR_B } from './clash-colors.js';
import {
  focusClashGroup,
  focusedCameraViewpointIsCurrent,
  focusedSceneRevisionIsCurrent,
  type FocusedClashGroup,
} from './group-focus.js';

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
      mutationViews: new Map(),
      hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
      hiddenEntitiesByModel: new Map(), isolatedEntitiesByModel: new Map(), mutationVersion: 0,
      colorPresentationRevision: 0,
      selectedStoreys: new Set(), levelDisplayMode: 'stacked',
      appliedStoreyOffsets: new Map(), pendingMeshTranslations: null, classFilter: null,
      typeVisibility: {
        spaces: true, spatialZones: true, openings: true, virtualElements: true,
        site: true, ifcAnnotations: true, ifcGrid: true,
      },
      typeViewMode: 'model',
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

  it('focuses and colors renderable parts of a geometry-less aggregate', () => {
    const applyFocusMode = mock.fn();
    useViewerStore.setState({
      cameraCallbacks: {
        resolveHighlightIds: (ids) => ids.flatMap((id) => id === 10 ? [11, 12] : [id]),
      },
    });

    const focused = focusClashGroup(
      [clash('assembly', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      applyFocusMode,
      'isolate',
    );
    assert.ok(focused);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([11, 12, 20, 10]),
      'renderer selection includes the assembly parts while retaining the raw ids');
    assert.deepEqual(applyFocusMode.mock.calls[0].arguments, [[11, 12, 20, 10], 'isolate'],
      'isolation must not whitelist only the geometry-less assembly id');
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([
      [11, CLASH_COLOR_A], [12, CLASH_COLOR_A], [10, CLASH_COLOR_A], [20, CLASH_COLOR_B],
    ]), 'the same presentation expansion paints every renderable assembly part');
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

  it('uses one reproducible color when distinct model occurrences share an IFC GlobalId', () => {
    const crossRevision = clash('cross-revision', 10, 10);
    crossRevision.b.model = 'revision-b';
    useViewerStore.setState({
      models: new Map([
        ['model', {
          idOffset: 0,
          ifcDataStore: { entities: { getGlobalId: () => 'SHARED-GUID' } },
        }],
        ['revision-b', {
          idOffset: 1000,
          ifcDataStore: { entities: { getGlobalId: () => 'SHARED-GUID' } },
        }],
      ]) as unknown as ViewerState['models'],
    });

    const focused = focusClashGroup(
      [crossRevision],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([
      [10, CLASH_COLOR_A], [1010, CLASH_COLOR_A],
    ]));
    assert.deepEqual(focused.aGuids, ['SHARED-GUID']);
    assert.deepEqual(focused.bGuids, [],
      'BCF cannot assign two colors to the same GUID, so the PNG must not either');
  });

  it('colors every loaded occurrence addressed by the exported BCF GlobalId', () => {
    const crossRevision = clash('cross-revision-loaded', 10, 10);
    crossRevision.b.model = 'revision-b';
    const entities = (expressId: number) => ({
      getGlobalId: () => 'SHARED-GUID',
      getExpressIdByGlobalId: (guid: string) => guid === 'SHARED-GUID' ? expressId : -1,
    });
    useViewerStore.setState({
      models: new Map([
        ['model', { idOffset: 0, ifcDataStore: { entities: entities(10) } }],
        ['revision-b', { idOffset: 1000, ifcDataStore: { entities: entities(10) } }],
        ['revision-c', { idOffset: 2000, ifcDataStore: { entities: entities(30) } }],
      ]) as unknown as ViewerState['models'],
    });

    const focused = focusClashGroup(
      [crossRevision],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([
      [10, CLASH_COLOR_A], [1010, CLASH_COLOR_A], [2030, CLASH_COLOR_A],
    ]), 'the PNG must paint every loaded occurrence that BCF will color by shared GUID');
    assert.deepEqual(focused.modelIds, ['model', 'revision-b'],
      'an unrelated revision is colored for BCF parity without becoming a group participant');
  });

  it('reconciles every GUID occurrence when loaded models collide on one renderer id', () => {
    const crossModel = clash('guid-renderer-collision', 10, 20);
    crossModel.b.model = 'revision-b';
    const entities = (guid: string, expressId: number) => ({
      getGlobalId: () => guid,
      getExpressIdByGlobalId: (candidate: string) => candidate === guid ? expressId : -1,
    });
    useViewerStore.setState({
      models: new Map([
        ['model', { idOffset: 0, ifcDataStore: { entities: entities('GUID-A', 10) } }],
        ['revision-b', { idOffset: 1000, ifcDataStore: { entities: entities('GUID-B', 20) } }],
        ['colliding-b', { idOffset: 0, ifcDataStore: { entities: entities('GUID-B', 10) } }],
      ]) as unknown as ViewerState['models'],
    });

    const focused = focusClashGroup(
      [crossModel],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([
      [10, CLASH_COLOR_A], [1020, CLASH_COLOR_A],
    ]), 'a collision promotes every occurrence of the B GUID to the renderer-visible A color');
    assert.deepEqual(focused.aGuids, ['GUID-A', 'GUID-B']);
    assert.deepEqual(focused.bGuids, []);
  });

  it('colors StoreEditor-created occurrences addressed by the exported BCF GlobalId', () => {
    const overlay = new MutablePropertyView(null, 'overlay-revision');
    overlay.setExpressIdWatermark(29);
    overlay.createEntity('IfcWall', ['SHARED-GUID']);
    const crossRevision = clash('overlay-occurrence', 10, 10);
    crossRevision.b.model = 'revision-b';
    const entities = (expressId: number) => ({
      getGlobalId: () => 'SHARED-GUID',
      getExpressIdByGlobalId: (guid: string) => guid === 'SHARED-GUID' ? expressId : -1,
    });
    useViewerStore.setState({
      models: new Map([
        ['model', { idOffset: 0, ifcDataStore: { entities: entities(10) } }],
        ['revision-b', { idOffset: 1000, ifcDataStore: { entities: entities(10) } }],
        ['overlay-revision', { idOffset: 2000, ifcDataStore: { entities: {} } }],
      ]) as unknown as ViewerState['models'],
      mutationViews: new Map([['overlay-revision', overlay]]),
    });

    const focused = focusClashGroup(
      [crossRevision],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.deepEqual(useViewerStore.getState().clashHighlightColors, new Map([
      [10, CLASH_COLOR_A], [1010, CLASH_COLOR_A], [2030, CLASH_COLOR_A],
    ]));
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

  it('invalidates a focused frame when the visible section plane changes while capture waits', () => {
    useViewerStore.setState((state) => ({
      activeTool: 'section',
      sectionPlane: { ...state.sectionPlane, enabled: true, parked: false, position: 25 },
    }));
    const beforeSectionChange = focusClashGroup(
      [clash('section', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'ghost',
    );
    assert.ok(beforeSectionChange);
    useViewerStore.setState((state) => ({
      sectionPlane: { ...state.sectionPlane, position: 75 },
    }));
    assert.equal(focusedSceneRevisionIsCurrent(beforeSectionChange), false,
      'the serialized cut must come from the same rendered frame as the snapshot');
  });

  it('clears storey isolation canonically and invalidates a later level-display change', () => {
    useViewerStore.setState({
      selectedStoreys: new Set([44]),
      levelDisplayMode: 'solo',
    });
    const focused = focusClashGroup(
      [clash('storey', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'isolate',
    );
    assert.ok(focused);
    assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');
    assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set(),
      'manual-group framing must not inherit an unserializable storey filter');

    useViewerStore.getState().setStoreysSelection([55]);
    assert.equal(focusedSceneRevisionIsCurrent(focused), false,
      'a storey isolation enabled during snapshot capture must invalidate the frame');
  });

  it('clears an unserializable class filter and invalidates its reactivation', () => {
    useViewerStore.setState({
      classFilter: { ids: new Set([10]), label: 'IfcWall' },
    });
    const focused = focusClashGroup(
      [clash('class-filter', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'isolate',
    );
    assert.ok(focused);
    assert.equal(useViewerStore.getState().classFilter, null,
      'manual-group framing must not inherit a visibility gate BCF cannot serialize');

    useViewerStore.getState().setClassFilter([10], 'IfcWall');
    assert.equal(focusedSceneRevisionIsCurrent(focused), false,
      'a class filter enabled during snapshot capture must invalidate the frame');
  });

  it('normalizes unserializable type filters before framing and invalidates later changes', async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const frameSelection = mock.fn();
    useViewerStore.setState({
      cameraCallbacks: { frameSelection },
      typeVisibility: {
        spaces: false, spatialZones: false, openings: false, virtualElements: false,
        site: true, ifcAnnotations: true, ifcGrid: true,
      },
      typeViewMode: 'types',
    });
    const focused = focusClashGroup(
      [clash('type-filter', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'isolate',
    );
    assert.ok(focused);
    const state = useViewerStore.getState();
    assert.ok(Object.values(state.typeVisibility).every(Boolean),
      'manual-group framing must show every IFC type BCF cannot filter');
    assert.equal(state.typeViewMode, 'model',
      'manual-group framing must show placed occurrences, not the type library');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 0,
      'framing must wait until the rebuilt all-types geometry has painted');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 1);

    state.setTypeViewMode('types');
    assert.equal(focusedSceneRevisionIsCurrent(focused), false,
      'switching to type-library geometry during capture must invalidate the frame');

    const beforeVisibilityChange = focusClashGroup(
      [clash('type-filter-later', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'isolate',
    );
    assert.ok(beforeVisibilityChange);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    useViewerStore.getState().toggleTypeVisibility('spaces');
    assert.equal(focusedSceneRevisionIsCurrent(beforeVisibilityChange), false,
      'a type filter enabled during snapshot capture must invalidate the frame');
  });

  it('reveals hidden participating models before framing the exported group', async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const frameSelection = mock.fn();
    useViewerStore.setState({
      cameraCallbacks: { frameSelection },
      models: new Map([
        ['model', {
          idOffset: 0,
          visible: true,
          ifcDataStore: { entities: { getGlobalId: (id: number) => `MODEL-${id}` } },
        }],
        ['hidden', {
          idOffset: 1000,
          visible: false,
          ifcDataStore: { entities: { getGlobalId: (id: number) => `HIDDEN-${id}` } },
        }],
      ]) as unknown as ViewerState['models'],
    });
    const hiddenMember = clash('hidden-model', 10, 20);
    hiddenMember.b.model = 'hidden';
    const focused = focusClashGroup(
      [hiddenMember],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.equal(useViewerStore.getState().models.get('hidden')?.visible, true,
      'a serialized component cannot remain absent from the PNG');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 0,
      'framing must wait until the newly visible model has painted');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 1);

    useViewerStore.getState().setModelVisibility('hidden', false);
    assert.equal(focusedSceneRevisionIsCurrent(focused), false,
      'rehiding a participating model during capture invalidates the scene');
  });

  it('waits for exploded offsets to be reverted and painted before framing', async () => {
    // Drain frame requests left by the synchronous assertions above before
    // installing this test's callback (the callback is read at frame time).
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const frameSelection = mock.fn();
    useViewerStore.setState({
      cameraCallbacks: { frameSelection },
      levelDisplayMode: 'exploded',
      appliedStoreyOffsets: new Map([['model', new Map([[44, 8]])]]),
    });
    const focused = focusClashGroup(
      [clash('exploded', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 0, 'old lifted bounds must not be framed');

    useViewerStore.setState({
      appliedStoreyOffsets: new Map(),
      pendingMeshTranslations: new Map([[10, [0, -8, 0]]]),
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 0, 'the renderer has not drained the inverse translation');

    useViewerStore.setState({ pendingMeshTranslations: null });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 0, 'one paint frame follows queue drain');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(frameSelection.mock.callCount(), 1);
    await focused.frameReady;
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
    assert.equal(requestedDuration, 0, 'capture uses synchronous framing, not the interactive 300 ms animation');
    assert.equal(frameReady, false, 'one animation frame is not the end of camera framing');
    finishFraming();
    await focused.frameReady;
    assert.equal(frameReady, true);
  });

  it('invalidates a capture when navigation changes the framed camera pose (#4921)', () => {
    const viewpoint = (x: number) => ({
      position: { x, y: 2, z: 3 },
      target: { x: 4, y: 5, z: 6 },
      up: { x: 0, y: 1, z: 0 },
      fov: 45,
      projectionMode: 'perspective' as const,
    });
    let current = viewpoint(1);
    useViewerStore.setState({ cameraCallbacks: { getViewpoint: () => current } });
    const framed = { viewpoint: current };
    assert.equal(focusedCameraViewpointIsCurrent(framed), true);
    current = viewpoint(7);
    assert.equal(focusedCameraViewpointIsCurrent(framed), false,
      'camera navigation during the paint/snapshot wait must invalidate the authored viewpoint');
  });

  it('does not treat an unavailable camera frame callback as capture-ready (#4921)', async () => {
    const focused = focusClashGroup(
      [clash('no-camera', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    const framed = await focused.frameReady;
    assert.equal(framed, null);
    assert.equal(focusedCameraViewpointIsCurrent(framed), false,
      'capture must abort rather than accepting the pre-frame camera pose');
  });

  it('does not capture when selection framing reports no renderable bounds (#4921)', async () => {
    useViewerStore.setState({ cameraCallbacks: { frameSelection: () => false } });
    const focused = focusClashGroup(
      [clash('no-bounds', 10, 20)],
      (element) => ({ modelId: element.model, expressId: element.ref }),
      mock.fn(),
      'highlight',
    );
    assert.ok(focused);
    assert.equal(await focused.frameReady, null,
      'a resolved entity without renderable geometry must not reuse the previous camera view');
  });
});
