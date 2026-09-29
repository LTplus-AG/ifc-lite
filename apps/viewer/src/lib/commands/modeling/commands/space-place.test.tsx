/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `space.place` (charter #6232, lane A2): the interim space command. A
 * rectangle or a polygon outline, drawn like a slab's, written as an IfcSpace
 * by the in-store `addSpace`: extruded by the space Height, aggregated under
 * the session storey, one undo step, re-meshed through wasm.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click as clickEl, press, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { authoredBodies } from '@/test/authored-body';
import { SpacePlaceBar } from '@/components/viewer/tools/command/SpacePlaceBar';
import { commandKind } from '../authored-kinds.js';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { SPACE_PLACE, type SpacePlaceGesture } from './space-place.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as SpacePlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const spaces = () => authoredBodies(MODEL_ID, ['IFCSPACE']).map(({ expressId: _id, ...b }) => b);

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  const s = useViewerStore.getState();
  s.setAuthoringDefaults({ spaceMode: 'rectangle' });
  s.setAuthoringDims('space', { Height: 2.8 });
  if (s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
  s.startCommand('space.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

const BODY = { cls: 'IFCSPACE', identifier: 'Body', representationType: 'SweptSolid', solid: 'IFCEXTRUDEDAREASOLID', depth: 2.8 };

describe('space.place (#6232 A2)', () => {
  it('two corners make one IfcSpace with a rectangle body the space Height tall, one undo step', () => {
    const before = undoDepth();
    click(1, 1);
    assert.deepEqual(spaces(), [], 'the first click only sets a corner');
    click(5, 4);
    assert.deepEqual(spaces(), [{ ...BODY, profile: 'IFCRECTANGLEPROFILEDEF' }]);
    assert.equal(undoDepth(), before + 1, 'one transaction');
    assert.equal(remeshed.length, 1, 'the commit asks the wasm re-mesh service for true geometry');
    const [space] = authoredBodies(MODEL_ID, ['IFCSPACE']);
    assert.deepEqual(useViewerStore.getState().readEntityPosition(MODEL_ID, space.expressId), [1, 1, 0], 'the min corner, storey-local');
    const aggregates = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities()
      .filter((e) => e.type.toUpperCase() === 'IFCRELAGGREGATES')
      .map((e) => [e.attributes[4], e.attributes[5]]);
    assert.deepEqual(aggregates, [[`#${STOREY}`, [`#${space.expressId}`]]], 'aggregated under the storey, not contained in it');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(spaces(), [], 'one undo removes the whole space');
    assert.equal(undoDepth(), before);
  });

  it('a polygon closes on Enter into one IfcSpace with an arbitrary-profile body, one undo step', () => {
    const ui = render(<SpacePlaceBar gesture={gesture()} ctx={ctx()} />);
    clickEl([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Polygon')!);
    assert.equal(gesture().mode, 'polygon');
    assert.equal(useViewerStore.getState().authoringDefaults.spaceMode, 'polygon', 'the next space starts as a polygon too');
    const before = undoDepth();
    for (const [x, y] of [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] as const) click(x, y);
    assert.deepEqual(spaces(), []);
    press(document.body, 'Enter');
    assert.deepEqual(spaces(), [{ ...BODY, profile: 'IFCARBITRARYCLOSEDPROFILEDEF' }]);
    assert.equal(undoDepth(), before + 1);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(spaces(), []);
  });

  it('a double-click closes the polygon; two corners are refused', () => {
    useViewerStore.getState().setAuthoringDefaults({ spaceMode: 'polygon' });
    useViewerStore.getState().startCommand('space.place');
    click(0, 0);
    click(3, 0);
    press(document.body, 'Enter');
    assert.deepEqual(spaces(), [], 'two corners are refused');
    click(3, 3);
    act(() => { commandDoubleClick(at(3, 3)); });
    assert.equal(spaces().length, 1);
  });

  it('shows spaces once one is drawn (spaces are hidden by default)', () => {
    assert.equal(useViewerStore.getState().typeVisibility.spaces, false);
    click(0, 0);
    click(2, 2);
    assert.equal(useViewerStore.getState().typeVisibility.spaces, true);
  });

  it('the inspector defaults follow the space kind while drawing', () => {
    assert.equal(commandKind('space.place', useViewerStore.getState().authoringDefaults), 'space');
  });

  it('previews a prism of the space Height', () => {
    click(1, 1);
    act(() => { commandPointerMove(at(4, 3)); });
    const [ghost] = SPACE_PLACE.ghost!(gesture(), ctx());
    const plane = ctx().workplane!;
    const zs: number[] = [];
    for (let i = 0; i < ghost.positions.length; i += 3) {
      zs.push(plane.renderToLocal([ghost.positions[i], ghost.positions[i + 1], ghost.positions[i + 2]])[2]);
    }
    assert.deepEqual([Math.min(...zs), Math.max(...zs)].map((v) => +v.toFixed(6)), [0, 2.8]);
  });
});
