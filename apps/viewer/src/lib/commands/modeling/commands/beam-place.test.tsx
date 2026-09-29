/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `beam.place` (charter #6232, M2.2): drawn like a wall (two clicks, chained,
 * typed Length / Angle), written as IfcBeam or IfcMember with its underside
 * `Bottom at` above the workplane. Each beam is ONE undo step.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click as clickEl, press, render, type } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { BeamPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { BEAM_PLACE, type BeamPlaceGesture } from './beam-place.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as BeamPlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const round = (v: number) => +v.toFixed(6);

/**
 * Every live overlay beam or member: its class, its storey-local axis start
 * (the placement origin), its length and its section (Width × Height).
 */
function beams(): { cls: string; start: number[]; length: number; section: [number, number] }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
  const ref = (v: unknown) => byId.get(Number(String(v).slice(1)))!;
  return view.getNewEntities()
    .filter((e) => ['IFCBEAM', 'IFCMEMBER'].includes(e.type.toUpperCase()) && !view.isDeleted(e.expressId))
    .map((e) => {
      const rep = ref((ref(e.attributes[6]).attributes[2] as string[])[0]);
      const solid = ref((rep.attributes[3] as string[])[0]);
      const profile = ref(solid.attributes[0]);
      return {
        cls: e.type.toUpperCase(),
        start: s.readEntityPosition(MODEL_ID, e.expressId)!.map(round),
        length: round(solid.attributes[3] as number),
        section: [round(profile.attributes[3] as number), round(profile.attributes[4] as number)],
      };
    });
}

let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setAuthoringDefaults({ beamClass: 'beam', chain: true });
  restoreRemesh = setRequestRemesh(() => {});
  useViewerStore.getState().startCommand('beam.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('beam.place (#6232 M2.2)', () => {
  it('chains beams, each one undo step; the section axis sits half a height above Bottom at', () => {
    const before = undoDepth();
    click(0, 0);
    click(5, 0);
    click(5, 4);
    // Default beam: 0.3 × 0.5, Bottom at 0 → the axis runs at z 0.25.
    assert.deepEqual(beams(), [
      { cls: 'IFCBEAM', start: [0, 0, 0.25], length: 5, section: [0.3, 0.5] },
      { cls: 'IFCBEAM', start: [5, 0, 0.25], length: 4, section: [0.3, 0.5] },
    ]);
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(beams().length, 1, 'one undo removes exactly the last beam');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before);
  });

  it('a typed Bottom at raises the beam (a lintel over a door, a beam under a slab)', () => {
    const ui = render(<CommandFieldsBar />);
    click(0, 0);
    act(() => { commandPointerMove(at(3, 0)); });
    press(document.body, 'Tab'); // Length
    for (let i = 0; i < 4; i++) press(ui.querySelector('input') as HTMLInputElement, 'Tab'); // Angle, Width, Height, Bottom at
    const input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Bottom at');
    type(input, '2.5');
    press(input, 'Enter');
    assert.deepEqual(beams()[0].start, [0, 0, 2.75]);
  });

  it('the Member segment writes an IfcMember with the member section', () => {
    const ui = render(<BeamPlaceBar />);
    clickEl([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Member')!);
    click(0, 0);
    click(0, 2);
    assert.deepEqual(beams(), [{ cls: 'IFCMEMBER', start: [0, 0, 0.05], length: 2, section: [0.1, 0.1] }]);
  });

  it('Chain off starts afresh after each beam', () => {
    useViewerStore.getState().setAuthoringDefaults({ chain: false });
    click(0, 0);
    click(2, 0);
    assert.deepEqual(gesture().chain, []);
    click(4, 0);
    assert.equal(beams().length, 1, 'the next click only starts the next beam');
  });

  it('a double-click ends the chain at the double-clicked point', () => {
    click(0, 0);
    click(3, 0);
    act(() => { commandDoubleClick(at(3, 0)); });
    assert.deepEqual(gesture().chain, []);
    assert.equal(beams().length, 1);
  });

  it('previews the beam between Bottom at and its top', () => {
    useViewerStore.getState().setAuthoringDims('beam', { Bottom: 1 });
    click(0, 0);
    act(() => { commandPointerMove(at(4, 0)); });
    const [ghost] = BEAM_PLACE.ghost!(gesture(), ctx());
    assert.ok(ghost);
    const plane = ctx().workplane!;
    const zs: number[] = [];
    for (let i = 0; i < ghost.positions.length; i += 3) {
      zs.push(plane.renderToLocal([ghost.positions[i], ghost.positions[i + 1], ghost.positions[i + 2]])[2]);
    }
    assert.deepEqual([round(Math.min(...zs)), round(Math.max(...zs))], [1, 1.5]);
  });
});
