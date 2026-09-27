/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.moveEndpoint` (charter #6232, WP2): grabbing a wall end handle runs
 * the command; while dragging only a ghost moves, the wall is untouched and
 * nothing is recorded; release writes ONE `resizeWall` (one undo step) and
 * hands back the select tool. Escape, or a press without a drag, writes
 * nothing. Also: the handles are drawn through the wall storey's workplane,
 * follow a reposition, and grabbing one starts the command.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, press, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { WallEndpointOverlay } from '@/components/viewer/tools/WallEndpointOverlay';
import type { PlacementState } from '@/lib/model-placement/state';
import type { SnapResult, Vec3 } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerMove, getCommandRuntime } from '../runtime.js';
import type { CommandContext } from '../types.js';
import { WALL_MOVE_ENDPOINT, beginWallEndpointDrag, type WallEndpointGesture } from './wall-move-endpoint.js';

let wallId = 0;
const gesture = () => getCommandRuntime().gesture as WallEndpointGesture;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const ends = () => useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId);
const release = () => act(() => { window.dispatchEvent(new window.PointerEvent('pointerup')); });

/** Move the drag to storey-local (x, y) through the wall's own workplane. */
function dragTo(x: number, y: number): void {
  const plane = gesture().plane!;
  const snap: SnapResult = { local: [x, y], render: plane.localToRender([x, y, 0]), winner: null, guides: [], locked: false };
  commandPointerMove(snap);
}

beforeEach(async () => {
  await seedModelingSession();
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  wallId = wall.expressId;
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, wallId));
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('wall.moveEndpoint (#6232 WP2)', () => {
  it('ghosts during the drag and writes ONE resizeWall on release', () => {
    const before = undoDepth();
    beginWallEndpointDrag('end');
    assert.equal(getCommandRuntime().command?.id, 'wall.moveEndpoint');
    dragTo(5, 1);
    dragTo(6, 1);
    assert.deepEqual(ends()?.end, [4, 0, 0], 'the wall is untouched while dragging');
    assert.equal(undoDepth(), before, 'nothing is recorded while dragging');
    const [ghost] = WALL_MOVE_ENDPOINT.ghost!(gesture(), getCommandRuntime().ctx as CommandContext);
    assert.ok(ghost, 'a ghost shows the new wall');

    release();
    const after = ends()!;
    assert.deepEqual(after.start.map((v) => +v.toFixed(6)), [0, 0, 0]);
    assert.deepEqual(after.end.map((v) => +v.toFixed(6)), [6, 1, 0]);
    assert.equal(useViewerStore.getState().activeTool, 'select', 'release hands back the select tool');
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(ends()?.end.map((v) => +v.toFixed(6)), [4, 0, 0], 'one undo restores the wall');
    assert.equal(undoDepth(), before);
  });

  it('Escape during the drag, or a press without a drag, writes nothing', () => {
    const before = undoDepth();
    beginWallEndpointDrag('start');
    dragTo(-2, 0);
    press(document.body, 'Escape');
    assert.equal(getCommandRuntime().command, null);
    release();
    beginWallEndpointDrag('start');
    release();
    assert.equal(getCommandRuntime().command, null);
    assert.deepEqual(ends()?.start, [0, 0, 0]);
    assert.equal(undoDepth(), before);
  });

  it('draws the handles through the workplane, follows a reposition, and a grab starts the command', () => {
    const projected: Vec3[] = [];
    useViewerStore.setState({
      activeTool: 'select',
      selectedEntity: { modelId: MODEL_ID, expressId: wallId },
      cameraCallbacks: {
        projectToScreen: (p: { x: number; y: number; z: number }) => { projected.push([p.x, p.y, p.z]); return { x: 10, y: 10 }; },
        getViewpoint: () => null,
      },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const ui = render(<WallEndpointOverlay />);
    assert.deepEqual(projected[0], [0, 0, -0], 'start handle at the wall start');
    projected.length = 0;

    // Moved AND turned 90° CCW about the origin: [0,0] → [0,0] + [10,5];
    // the end [4,0] → [0,4] + [10,5] = [10,9]. Engineering → render: [x, z, -y].
    const placement: PlacementState = {
      realignedFrameKey: null,
      placements: new Map([[MODEL_ID, { translation: [10, 5, 0], rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] }, locked: false }]]),
      preview: null, undo: [], redo: [], revision: 1,
    };
    act(() => useViewerStore.setState({ modelPlacement: placement }));
    const [start, end] = projected;
    assert.ok(Math.abs(start[0] - 10) < 1e-9 && Math.abs(start[2] + 5) < 1e-9, `start ${start}`);
    assert.ok(Math.abs(end[0] - 10) < 1e-9 && Math.abs(end[2] + 9) < 1e-9, `end ${end}`);

    const handle = ui.querySelector('[data-wall-end="end"] circle')!;
    act(() => { handle.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); });
    assert.equal(getCommandRuntime().command?.id, 'wall.moveEndpoint');
    assert.equal(gesture().which, 'end');
  });
});
