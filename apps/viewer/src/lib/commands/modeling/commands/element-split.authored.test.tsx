/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.split` on the demo project's shape (#6233): a MILLIMETRE file
 * whose storey sits 3 m east and 3 m north of the model origin.
 *
 * - A wall authored there is cut under the cursor. The chains are
 *   storey-local metres; the cursor reaches them through the storey's own
 *   workplane. (Picking in the model frame cut a storey offset away, and a
 *   millimetre chain clamped every cut to distance 0.)
 * - A column is cut at the cursor HEIGHT: its axis is vertical, so dropping
 *   the workplane's local z projected every cut to its base.
 * - An element Split cannot cut (the demo's mesh-bodied walls) keeps the
 *   command running with the reason as its hint; a click reports that same
 *   reason, transiently, and leaving the command clears it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { Toaster } from '@/components/ui/toast';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, press, render } from '@/test/render.js';
import { MESH_WALL, MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult } from '@/lib/snap/types';
import type { Vec3 } from '../types.js';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { SplitGesture } from './element-split.js';

const snapAt = (render: Vec3): SnapResult => ({ local: [0, 0], render, winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as SplitGesture;

function startOn(expressId: number): void {
  const s = useViewerStore.getState();
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, expressId));
  s.startCommand('element.split');
}

function toastTexts(): string[] {
  return [...document.querySelectorAll('button[aria-label="Dismiss notification"]')]
    .map((button) => button.parentElement?.textContent ?? '');
}

let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] });
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) {
    act(() => button.click());
  }
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  restoreRemesh();
});

describe('element.split on authored elements in a mm file on an offset storey (#6233)', () => {
  it('cuts a wall under the cursor', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 });
    assert.ok('expressId' in wall);
    startOn(wall.expressId);
    const plane = gesture().plane;
    assert.ok(plane, 'the offset storey has a workplane');
    // The storey hangs 3 m east: storey-local x = 1 renders at x = 4.
    const cursor = plane.localToRender([1, 0.05, 1.2]);
    assert.ok(Math.abs(cursor[0] - 4) < 1e-6, `render x ${cursor[0]}, want 4`);

    commandPointerMove(snapAt(cursor));
    const hover = gesture().hover;
    assert.ok(hover && Math.abs(hover.distance - 1) < 1e-6, `cut at ${hover?.distance} m, want 1 m (under the cursor)`);
    assert.ok(Math.abs(hover.length - 4) < 1e-6, `wall length ${hover.length} m, want 4 m`);
    assert.ok(Math.abs(hover.render[0] - 4) < 1e-6, 'the preview is drawn under the cursor');

    commandPointerDown(snapAt(cursor));
    // The source is replaced by two walls meeting at the cut.
    const pieces = [...(useViewerStore.getState().mutationViews.get(MODEL_ID)?.getNewEntities() ?? [])]
      .filter((e) => e.type.toUpperCase() === 'IFCWALL' && e.expressId !== wall.expressId)
      .map((e) => useViewerStore.getState().readWallEndpoints(MODEL_ID, e.expressId))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => [p.start[0], p.end[0]])
      .sort((a, b) => a[0] - b[0]);
    assert.deepEqual(pieces.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [[0, 1], [1, 4]]);
  });

  it('cuts a column at the cursor height', () => {
    const column = useViewerStore.getState().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    assert.ok('expressId' in column);
    startOn(column.expressId);
    const plane = gesture().plane;
    assert.ok(plane);
    commandPointerMove(snapAt(plane.localToRender([2.1, 2, 1.2])));
    const hover = gesture().hover;
    assert.ok(hover && Math.abs(hover.distance - 1.2) < 1e-6, `cut at ${hover?.distance} m, want 1.2 m`);
  });

  it('refuses a mesh-bodied wall with the Split button\'s reason, transiently, cleared on exit', () => {
    render(<Toaster />);
    startOn(MESH_WALL);
    const reason = "Can't split: the geometry is a mesh or B-rep, not a profile extrusion";
    assert.equal(gesture().refusal, 'splitTool.unavailable.mesh', 'the hint names the reason');

    act(() => commandPointerDown(snapAt([0, 0, 0])));
    assert.ok(toastTexts().some((text) => text.includes(reason)), `expected the refusal, got ${JSON.stringify(toastTexts())}`);
    assert.equal(getCommandRuntime().command?.id, 'element.split', 'the command keeps running');

    act(() => press(document.body, 'Escape'));
    assert.equal(getCommandRuntime().command, null);
    assert.deepEqual(toastTexts(), [], 'the refusal must not outlive the command');
  });
});
