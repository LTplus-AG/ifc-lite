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
import { emptyPlacementState, type PlacementState } from '@/lib/model-placement/state';
import { setRemeshClientFactory, type RemeshClientLike } from '@/lib/remesh/remesh-service';
import type { RemeshRequest, RemeshResult, StyleWire } from '@ifc-lite/geometry/remesh';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerMove, getCommandRuntime } from '../runtime.js';
import type { CommandContext, Vec3 } from '../types.js';
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

  it('release re-meshes the wall once, as the resize registered it (with what it hosts)', async () => {
    // A scripted worker in place of the wasm one; the model carries the RTC
    // frame the re-mesh service meshes in.
    const requests: RemeshRequest[] = [];
    const client: RemeshClientLike = {
      alive: true,
      remesh: (request) => { requests.push(request); return new Promise<RemeshResult>(() => {}); },
      styleWire: () => Promise.resolve({
        styleIds: new Uint32Array(), styleColors: new Uint8Array(),
        materialElementIds: new Uint32Array(), materialColorCounts: new Uint32Array(), materialColors: new Uint8Array(),
      } as StyleWire),
      setConfig: () => {},
      dispose: () => {},
    };
    setRemeshClientFactory(async () => client);
    try {
      const model = useViewerStore.getState().models.get(MODEL_ID)!;
      const geometryResult = {
        ...model.geometryResult,
        coordinateInfo: { ...model.geometryResult!.coordinateInfo, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } },
      } as GeometryResult;
      useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult }]]) });

      beginWallEndpointDrag('end');
      dragTo(6, 1);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // `refreshWallMesh` asks once ('hostsChanged'); a second, 'shape' request
      // from the transaction would supersede it and re-register the batch.
      assert.equal(requests.length, 1, 'one re-mesh request for the release');
      assert.ok([...requests[0].targets].includes(wallId));
    } finally {
      setRemeshClientFactory(null);
    }
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

describe('wall.moveEndpoint on an offset storey in a mm file (ledger follow-up to #6282)', () => {
  // The demo project's shape: a millimetre file whose storey sits 3 m east
  // and 3 m north of the model origin. Render is [x, z, -y] of the model frame.
  beforeEach(async () => {
    useViewerStore.getState().exitModelWorkspace();
    await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] });
    // The reposition test above leaves a placement behind; this one measures the storey offset alone.
    useViewerStore.setState({ modelPlacement: emptyPlacementState() });
    const s = useViewerStore.getState();
    const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    wallId = wall.expressId;
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, wallId));
  });

  it('draws the handles on the wall, a storey offset from the model origin', () => {
    const projected: Vec3[] = [];
    useViewerStore.setState({
      activeTool: 'select',
      selectedEntity: { modelId: MODEL_ID, expressId: wallId },
      cameraCallbacks: {
        projectToScreen: (p: { x: number; y: number; z: number }) => { projected.push([p.x, p.y, p.z]); return { x: 10, y: 10 }; },
        getViewpoint: () => null,
      },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    render(<WallEndpointOverlay />);
    const [start, end] = projected;
    assert.ok(Math.abs(start[0] - 3) < 1e-6 && Math.abs(start[2] + 3) < 1e-6, `start handle at model (3, 3), got render ${start}`);
    assert.ok(Math.abs(end[0] - 7) < 1e-6 && Math.abs(end[2] + 3) < 1e-6, `end handle at model (7, 3), got render ${end}`);
  });

  it('a drag to a model-frame cursor writes the storey-local end under it', () => {
    beginWallEndpointDrag('end');
    // The cursor at model (7, 4): storey-local (4, 1).
    commandPointerMove({ local: [0, 0], render: [7, 0, -4], winner: null, guides: [], locked: false });
    release();
    assert.deepEqual(ends()?.end.map((v) => +v.toFixed(6)), [4, 1, 0]);
    assert.deepEqual(ends()?.start.map((v) => +v.toFixed(6)), [0, 0, 0]);
  });
});
