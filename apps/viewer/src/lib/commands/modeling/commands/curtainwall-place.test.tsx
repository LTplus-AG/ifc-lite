/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `curtainwall.place` (charter #6232, D3): two clicks make a curtain wall
 * whose parts (IfcMember mullions and transoms, IfcPlate panels) are
 * aggregated by the IfcCurtainWall, all ONE undo step; the ghost is the real
 * layout; every part is re-meshed; Panel width / height set the bays and rows;
 * the dimensions carry to the next wall.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, writeCommandField } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { CURTAINWALL_PLACE } from './curtainwall-place.js';
import { resetCurtainWallDimensions, type CurtainWallGesture } from './curtainwall-place-geometry.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift: false, alt: false } });
const gesture = () => getCommandRuntime().gesture as CurtainWallGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });

/** Every live overlay entity of these IFC classes (UPPERCASE). */
function live(...types: string[]) {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities().filter((e) => types.includes(e.type.toUpperCase()) && !view.isDeleted(e.expressId));
}
const count = (type: string) => live(type).length;

/** The related ids of the IfcRelAggregates whose relating object is `id`. */
function aggregated(id: number): number[] {
  const rel = live('IFCRELAGGREGATES').find((e) => e.attributes[4] === `#${id}`);
  return ((rel?.attributes[5] ?? []) as string[]).map((r) => Number(String(r).slice(1)));
}

const triangles = (mesh: { indices: ArrayLike<number> }) => mesh.indices.length / 3;

let remeshes: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  resetCurtainWallDimensions();
  remeshes = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshes.push(request); });
  useViewerStore.getState().startCommand('curtainwall.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('curtainwall.place (#6232 D3)', () => {
  it('two clicks write the curtain wall with every part aggregated, and one undo removes the lot', () => {
    const before = undoDepth();
    click(0, 0);
    click(6, 0);
    // 6 m at 1.5 m panels: 4 bays; 3 m at 1.5 m panels: 2 rows.
    const [wall] = live('IFCCURTAINWALL');
    assert.ok(wall, 'an IfcCurtainWall');
    assert.equal(count('IFCCURTAINWALL'), 1);
    // 5 mullions (4 bays + the closing one), (2 rows + 1) x 4 transoms, 8 panels.
    assert.equal(count('IFCMEMBER'), 5 + 3 * 4);
    assert.equal(count('IFCPLATE'), 8);
    const parts = aggregated(wall.expressId);
    assert.equal(parts.length, 5 + 3 * 4 + 8, 'the IfcRelAggregates ties every part to the curtain wall');
    assert.equal(count('IFCRELCONTAINEDINSPATIALSTRUCTURE') >= 1, true, 'the wall is contained in the storey');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(count('IFCCURTAINWALL'), 0);
    assert.equal(count('IFCMEMBER'), 0);
    assert.equal(count('IFCPLATE'), 0);
    assert.equal(undoDepth(), before, 'one undo step for the whole aggregate');
  });

  it('re-meshes the curtain wall and every part in one request', () => {
    click(0, 0);
    click(3, 0);
    assert.equal(remeshes.length, 1);
    const [wall] = live('IFCCURTAINWALL');
    const expected = [wall.expressId, ...aggregated(wall.expressId)];
    assert.deepEqual([...remeshes[0].expressIds].sort((a, b) => a - b), expected.sort((a, b) => a - b));
    assert.equal(remeshes[0].cause, 'created');
  });

  it('the ghost is the layout the builder writes: one prism per member and panel', () => {
    act(() => { commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0)); commandPointerMove(at(6, 0)); });
    const [frame, panels] = CURTAINWALL_PLACE.ghost!(gesture(), ctx());
    // A box is 12 triangles.
    assert.equal(triangles(frame), (5 + 3 * 4) * 12);
    assert.equal(triangles(panels), 8 * 12);
    click(6, 0);
    assert.equal(count('IFCMEMBER') * 12, triangles(frame));
    assert.equal(count('IFCPLATE') * 12, triangles(panels));
  });

  it('a typed Panel W and Panel H set the bays and rows', () => {
    const ui = render(<CommandFieldsBar />);
    click(0, 0);
    act(() => { commandPointerMove(at(6, 0)); });
    const labels = [...ui.querySelectorAll('[aria-label]')].map((i) => i.getAttribute('aria-label'));
    for (const label of ['Length', 'Angle', 'Height', 'Base', 'Panel W', 'Panel H', 'Mullion W', 'Mullion D']) {
      assert.ok(labels.includes(label), `the bar has a ${label} field`);
    }
    const index = (id: string) => CURTAINWALL_PLACE.fields!.findIndex((f) => f.id === id);
    act(() => { writeCommandField(index('panelWidth'), 2); writeCommandField(index('panelHeight'), 1); });
    assert.equal(gesture().panelWidth, 2);
    assert.equal(gesture().panelHeight, 1);
    click(6, 0);
    // 6 m at 2 m: 3 bays; 3 m at 1 m: 3 rows.
    assert.equal(count('IFCPLATE'), 9);
  });

  it('a base offset raises the wall above the workplane; the dimensions carry to the next wall', () => {
    const index = (id: string) => CURTAINWALL_PLACE.fields!.findIndex((f) => f.id === id);
    act(() => { writeCommandField(index('baseOffset'), 0.5); writeCommandField(index('height'), 2); });
    click(0, 0);
    click(3, 0);
    const [wall] = live('IFCCURTAINWALL');
    const position = useViewerStore.getState().readEntityPosition(MODEL_ID, wall.expressId);
    assert.deepEqual(position?.map((v) => Math.round(v * 1000) / 1000), [0, 0, 0.5]);
    // The next gesture (after the commit) starts with what was typed.
    assert.equal(gesture().baseOffset, 0.5);
    assert.equal(gesture().height, 2);
  });

  it('refuses a curtain wall that is too short, writing nothing', () => {
    const before = undoDepth();
    click(0, 0);
    click(0.1, 0);
    assert.equal(undoDepth(), before);
    assert.equal(count('IFCCURTAINWALL'), 0);
  });

  it('a curtain wall on the upper storey is contained in it, 3 m up', () => {
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    click(1, 1);
    click(5, 1);
    const [wall] = live('IFCCURTAINWALL');
    assert.ok(wall);
    const rel = live('IFCRELCONTAINEDINSPATIALSTRUCTURE').find((e) => (e.attributes[4] as string[]).includes(`#${wall.expressId}`));
    assert.equal(rel?.attributes[5], `#${UPPER_STOREY}`);
    const spatial = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.spatialHierarchy;
    assert.equal(spatial?.elementToStorey.get(wall.expressId), UPPER_STOREY);
  });
});
