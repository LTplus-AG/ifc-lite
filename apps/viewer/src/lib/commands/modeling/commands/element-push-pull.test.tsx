/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.pushPull` (#6232 C4). A face pulled writes exactly what typing the
 * same dimension into the inspector writes (same mutations, one undo step);
 * the handles are drawn on the selected element in the Model workspace, a
 * drag snaps and writes once on release, a press without a drag arms the face
 * for a typed size, and a size the element's openings cannot follow is
 * refused with nothing written.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Mutation } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, press, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { PushPullHandles } from '@/components/viewer/tools/command/PushPullHandles';
import { setElementDimensions } from '@/components/viewer/model-inspector/inspector-edits';
import { PUSH_PULL_COMMAND_ID } from '@/lib/push-pull/push-pull-drag';
import type { PushPullGesture } from '@/lib/push-pull/push-pull-gesture';
import { setRequestRemesh, runTransaction, type RemeshRequest } from '../transaction.js';
import '../builtin.js';
import { getModelingCommand } from '../registry.js';
import { commitCommand, getCommandRuntime, writeCommandField } from '../runtime.js';
import type { CommandContext } from '../types.js';
import { ELEMENT_PUSH_PULL } from './element-push-pull.js';

const s = () => useViewerStore.getState();
const undoStack = () => s().undoStacks.get(MODEL_ID) ?? [];
const gesture = () => getCommandRuntime().gesture as PushPullGesture;
const created = (made: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  return made.expressId;
};
const select = (expressId: number) => act(() => s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId)));
const height = (wall: number) => s().readWallEndpoints(MODEL_ID, wall)?.height;
/** What a mutation writes, without its identity (id, time). */
const effect = (m: Mutation): unknown => { const { id: _id, timestamp: _t, ...rest } = m as Mutation & { timestamp?: unknown }; return rest; };
const ctx = (): CommandContext => ({ get: useViewerStore.getState, modelId: MODEL_ID, storeyId: STOREY, workplane: null });

/** An orthographic front view, 100 px per metre, render +Y up the screen. */
const stubCamera = () => useViewerStore.setState({
  cameraCallbacks: { projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: 400 + p.x * 100, y: 400 - p.y * 100 }), getViewpoint: () => null },
} as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
const pointer = (target: EventTarget, type: string, init: PointerEventInit) => act(() => {
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
});

let remeshes: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  remeshes = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshes.push(request); });
  stubCamera();
});
afterEach(() => {
  restoreRemesh();
  cleanup();
  s().exitModelWorkspace();
});

/** Pull `faceId` of `expressId` to `size` through the command's transaction, as a release would. */
function pull(expressId: number, faceId: PushPullGesture['faceId'], size: number) {
  select(expressId);
  const g = { ...ELEMENT_PUSH_PULL.init(ctx()) as PushPullGesture, faceId, size };
  return runTransaction(useViewerStore, getModelingCommand(PUSH_PULL_COMMAND_ID)!, g, ctx());
}

describe('element.pushPull writes what the inspector writes (#6232 C4)', () => {
  const cases: { name: string; make: () => number; faceId: PushPullGesture['faceId']; size: number; patch: Parameters<typeof setElementDimensions>[2] }[] = [
    { name: 'wall height', make: () => created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 })), faceId: 'wall.top', size: 3.6, patch: { kind: 'wall', height: 3.6 } },
    { name: 'wall thickness', make: () => created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 })), faceId: 'wall.sideLeft', size: 0.45, patch: { kind: 'wall', thickness: 0.45 } },
    { name: 'slab thickness', make: () => created(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 })), faceId: 'slab.far', size: 0.35, patch: { kind: 'slab', thickness: 0.35 } },
    { name: 'column length from its head', make: () => created(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 })), faceId: 'linear.end', size: 3.5, patch: { kind: 'linear', length: 3.5, fixed: 'start' } },
    { name: 'beam length from its far end', make: () => created(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 })), faceId: 'linear.end', size: 5, patch: { kind: 'linear', length: 5, fixed: 'start' } },
  ];

  for (const { name, make, faceId, size, patch } of cases) {
    it(`${name}: same mutations, one undo step, then undone`, () => {
      const element = make();
      const before = undoStack().length;

      const outcome = pull(element, faceId, size);
      assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
      const pulled = undoStack().slice(before);
      assert.ok(pulled.length > 0);
      assert.equal(new Set(pulled.map((m) => s().mutationBatchTags.get(m.id))).size, 1, 'one batch: one undo step');
      const pulledEffects = pulled.map(effect);
      assert.deepEqual(remeshes.at(-1)?.expressIds.includes(element), true, 'the element is re-meshed');

      act(() => s().undo(MODEL_ID));
      assert.equal(undoStack().length, before, 'one undo takes the pull back');

      assert.equal(setElementDimensions(MODEL_ID, element, patch), true);
      const typedEffects = undoStack().slice(before).map(effect);
      assert.deepEqual(typedEffects, pulledEffects, 'typing the dimension writes the same records');
    });
  }

  it('a size the wall\'s openings cannot follow is refused, writing nothing', () => {
    const wall = created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 }));
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'door', params: { Offset: 2, Width: 0.9, Height: 2.1 } });
    assert.ok('expressId' in placed);
    const before = undoStack().length;
    const outcome = pull(wall, 'wall.top', 1.8);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.reason, /reaches above the new top/);
    assert.equal(undoStack().length, before, 'nothing was written');
    assert.equal(height(wall), 3);
    // Raised, it is fine: the door stays where it is.
    assert.equal(pull(wall, 'wall.top', 3.4).ok, true);
    assert.equal(height(wall), 3.4);
  });
});

describe('the handles (#6232 C4)', () => {
  let wall = 0;
  beforeEach(() => {
    wall = created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2 }));
    act(() => { s().enterModelWorkspace(); s().setActiveTool('select'); });
    select(wall);
  });

  const handle = (ui: HTMLElement, id: string) => ui.querySelector(`[data-push-pull-face="${id}"]`)!;

  it('are drawn on the selected wall only in the Model workspace, on its faces', () => {
    const ui = render(<PushPullHandles />);
    const ids = [...ui.querySelectorAll('[data-push-pull-face]')].map((g) => g.getAttribute('data-push-pull-face'));
    assert.deepEqual(ids, ['wall.top', 'wall.sideLeft', 'wall.sideRight']);
    act(() => s().exitModelWorkspace());
    assert.equal(ui.querySelector('[data-push-pull-face]'), null, 'no handles outside the workspace');
  });

  it('a drag pulls the top to the next floor level and writes once, on release', () => {
    const ui = render(<PushPullHandles />);
    const before = undoStack().length;
    pointer(handle(ui, 'wall.top'), 'pointerdown', { clientX: 400, clientY: 200 });
    assert.equal(getCommandRuntime().command?.id, PUSH_PULL_COMMAND_ID);
    assert.equal(gesture().faceId, 'wall.top');
    // 95 px up: the wall asks for 2.95 m, within reach of the storey above at 3 m.
    pointer(window, 'pointermove', { clientX: 400, clientY: 105 });
    assert.deepEqual([gesture().size, gesture().snapped], [3, 'level']);
    assert.equal(height(wall), 2, 'nothing is written while dragging');
    assert.equal(undoStack().length, before);
    assert.equal(remeshes.length, 0);

    pointer(window, 'pointerup', { clientX: 400, clientY: 105 });
    assert.equal(height(wall), 3);
    assert.equal(s().activeTool, 'select', 'release hands back the select tool');
    assert.deepEqual(remeshes.map((r) => r.expressIds), [[wall]], 'one re-mesh of the wall');
    act(() => s().undo(MODEL_ID));
    assert.equal(height(wall), 2, 'one undo restores it');
  });

  it('a side face pulled in plan grows the wall by twice the face travel, so the face follows the pointer', () => {
    // From above: render +X is screen right, render -Z (IFC +Y) is up the screen.
    useViewerStore.setState({
      cameraCallbacks: { projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: 400 + p.x * 100, y: 400 + p.z * 100 }), getViewpoint: () => null },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const ui = render(<PushPullHandles />);
    pointer(handle(ui, 'wall.sideLeft'), 'pointerdown', { clientX: 400, clientY: 400 });
    pointer(window, 'pointermove', { clientX: 400, clientY: 370 });
    assert.ok(Math.abs(gesture().size! - 0.8) < 1e-9, `0.2 m + 2 x 0.3 m, got ${gesture().size}`);
    pointer(window, 'pointerup', { clientX: 400, clientY: 370 });
    assert.equal(s().readWallEndpoints(MODEL_ID, wall)?.thickness, 0.8);
  });

  it('Alt drags free of the snap, and Escape cancels with nothing written', () => {
    const ui = render(<PushPullHandles />);
    pointer(handle(ui, 'wall.top'), 'pointerdown', { clientX: 400, clientY: 200 });
    pointer(window, 'pointermove', { clientX: 400, clientY: 105, altKey: true });
    assert.ok(Math.abs(gesture().size! - 2.95) < 1e-9 && gesture().snapped === null, `free drag, got ${gesture().size}`);
    act(() => press(document.body, 'Escape'));
    assert.equal(getCommandRuntime().command, null, 'Escape cancels');
    assert.equal(height(wall), 2);
  });

  it('a press without a drag arms the face; a typed size then applies with Enter and stops the pointer steering', () => {
    const ui = render(<PushPullHandles />);
    pointer(handle(ui, 'wall.top'), 'pointerdown', { clientX: 400, clientY: 200 });
    pointer(window, 'pointerup', { clientX: 400, clientY: 200 });
    assert.equal(getCommandRuntime().command?.id, PUSH_PULL_COMMAND_ID, 'still running, face armed');
    assert.equal(gesture().faceId, 'wall.top');
    assert.equal(height(wall), 2);

    act(() => writeCommandField(0, 4.2));
    pointer(window, 'pointermove', { clientX: 400, clientY: 100 });
    assert.equal(gesture().size, 4.2, 'the pointer no longer steers a typed size');
    act(() => { commitCommand(); });
    assert.equal(height(wall), 4.2);
    assert.equal(getCommandRuntime().command, null);
  });

  it('a commit the wall\'s door cannot follow is reported and leaves the command running', () => {
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'door', params: { Offset: 2, Width: 0.9, Height: 1.8 } });
    assert.ok('expressId' in placed);
    const ui = render(<PushPullHandles />);
    const before = undoStack().length;
    pointer(handle(ui, 'wall.top'), 'pointerdown', { clientX: 400, clientY: 200 });
    pointer(window, 'pointerup', { clientX: 400, clientY: 200 });
    act(() => writeCommandField(0, 1.2));
    act(() => { commitCommand(); });
    assert.equal(height(wall), 2, 'the wall stays as it was');
    assert.equal(undoStack().length, before);
    assert.equal(getCommandRuntime().command?.id, PUSH_PULL_COMMAND_ID);
  });
});
