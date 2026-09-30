/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Beam, Member and Column commands' Section picker (#6232 D2): the picked
 * kind is written as its IfcXProfileDef and extrusion, the ghost sweeps the
 * same section, the typed rectangle fields give way to the picker's, and the
 * choice is remembered for the next element. One undo step per element.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { advance, click as clickEl, cleanup, render, type, blur } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { authoredBodies } from '@/test/authored-body';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { BeamPlaceProfileBar, ColumnPlaceProfileBar } from '@/components/viewer/tools/command/ProfileBars';
import { authoringSection } from '@/store/slices/authoringDefaultsSlice';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { CommandContext } from '../types.js';

const s = () => useViewerStore.getState();
const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const bodies = () => authoredBodies(MODEL_ID, ['IFCBEAM', 'IFCMEMBER', 'IFCCOLUMN']);
const ctx = () => getCommandRuntime().ctx as CommandContext;
const labels = (root: HTMLElement) => [...root.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));

let restoreRemesh: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  s().setAuthoringDefaults({ beamClass: 'beam', chain: false });
  s().setAuthoringDefaults({
    profiles: { beam: { type: 'Rectangle', dims: {} }, member: { type: 'Rectangle', dims: {} }, column: { type: 'Rectangle', dims: {} } },
  });
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => {
  restoreRemesh();
  s().exitModelWorkspace();
  cleanup();
});

/** Ghost bounding box in the workplane's render space, so the section's outer size can be read off it. */
function ghostExtent(): { min: number[]; max: number[] } {
  const { command, gesture } = getCommandRuntime();
  const meshes = command!.ghost!(gesture, ctx());
  assert.equal(meshes.length, 1, 'one ghost mesh');
  const p = meshes[0].positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[k + a]); max[a] = Math.max(max[a], p[k + a]); }
  return { min, max };
}
const size = (box: { min: number[]; max: number[] }) => box.max.map((v, i) => +(v - box.min[i]).toFixed(4));

describe('beam.place with a section (#6232 D2)', () => {
  it('an I beam is one IfcBeam with an IfcIShapeProfileDef body, one undo step', () => {
    s().setAuthoringProfile('beam', 'I', { OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 });
    s().startCommand('beam.place');
    const before = undoDepth();
    click(0, 0);
    click(5, 0);
    assert.deepEqual(bodies().map(({ expressId: _id, ...b }) => b), [{
      cls: 'IFCBEAM', identifier: 'Body', representationType: 'SweptSolid', solid: 'IFCEXTRUDEDAREASOLID', profile: 'IFCISHAPEPROFILEDEF', depth: 5,
    }]);
    assert.equal(undoDepth() - before >= 1, true);
    const id = bodies()[0].expressId;
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 });
    // The axis runs half the section's depth above Bottom at: an I 0.4 deep sits at z 0.2.
    assert.deepEqual(s().readEntityPosition(MODEL_ID, id)!.map((v) => +v.toFixed(6)), [0, 0, 0.2]);
    s().undo(MODEL_ID);
    assert.deepEqual(bodies(), []);
    assert.equal(undoDepth(), before);
  });

  for (const [kind, cls] of [['L', 'IFCLSHAPEPROFILEDEF'], ['T', 'IFCTSHAPEPROFILEDEF'], ['U', 'IFCUSHAPEPROFILEDEF'], ['C', 'IFCCSHAPEPROFILEDEF'], ['Circle', 'IFCCIRCLEPROFILEDEF'], ['RectangleHollow', 'IFCRECTANGLEHOLLOWPROFILEDEF'], ['CircleHollow', 'IFCCIRCLEHOLLOWPROFILEDEF']] as const) {
    it(`a ${kind} beam is written as ${cls}`, () => {
      s().setAuthoringProfile('beam', kind);
      s().startCommand('beam.place');
      click(0, 0);
      click(3, 0);
      assert.deepEqual(bodies().map((b) => [b.cls, b.profile]), [['IFCBEAM', cls]]);
    });
  }

  it('a member takes its own section, remembered apart from the beam', () => {
    s().setAuthoringProfile('beam', 'I');
    s().setAuthoringProfile('member', 'Circle', { Radius: 0.05 });
    s().setAuthoringDefaults({ beamClass: 'member' });
    s().startCommand('beam.place');
    click(0, 0);
    click(0, 3);
    assert.deepEqual(bodies().map((b) => [b.cls, b.profile]), [['IFCMEMBER', 'IFCCIRCLEPROFILEDEF']]);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, bodies()[0].expressId), { Type: 'Circle', Radius: 0.05 });
  });

  it('the ghost sweeps the section: an I ghost is 0.2 wide and 0.4 deep, not the 0.3 x 0.5 rectangle', () => {
    s().setAuthoringProfile('beam', 'I', { OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 });
    s().startCommand('beam.place');
    act(() => { commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0)); commandPointerMove(at(5, 0)); });
    const sizes = size(ghostExtent()).slice().sort((a, b) => a - b);
    assert.deepEqual(sizes, [0.2, 0.4, 5], 'across, up and along the axis');
  });

  it('the rectangle stays the default and is written as before', () => {
    s().startCommand('beam.place');
    click(0, 0);
    click(4, 0);
    assert.deepEqual(bodies().map((b) => b.profile), ['IFCRECTANGLEPROFILEDEF']);
    assert.equal(authoringSection(s().authoringDefaults, 'beam'), null);
  });

  it('a picked section takes the rectangle\'s Width and Height fields out of the bar; Bottom at stays', () => {
    s().startCommand('beam.place');
    const ui = render(<CommandFieldsBar />);
    assert.deepEqual(labels(ui), ['Length', 'Angle', 'Width', 'Height', 'Bottom at']);
    act(() => s().setAuthoringProfile('beam', 'I'));
    assert.deepEqual(labels(ui), ['Length', 'Angle', 'Bottom at']);
  });
});

describe('column.place with a section (#6232 D2)', () => {
  it('a hollow circular column is one IfcColumn with an IfcCircleHollowProfileDef body, one undo step', () => {
    s().setAuthoringProfile('column', 'CircleHollow', { Radius: 0.15, WallThickness: 0.01 });
    s().startCommand('column.place');
    const before = undoDepth();
    click(2, 3);
    assert.deepEqual(bodies().map(({ expressId: _id, ...b }) => b), [{
      cls: 'IFCCOLUMN', identifier: 'Body', representationType: 'SweptSolid', solid: 'IFCEXTRUDEDAREASOLID', profile: 'IFCCIRCLEHOLLOWPROFILEDEF', depth: 3,
    }]);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, bodies()[0].expressId), { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 });
    s().undo(MODEL_ID);
    assert.deepEqual(bodies(), []);
    assert.equal(undoDepth(), before);
  });

  it('the ghost is the tube: 0.3 across and the column\'s Height tall', () => {
    s().setAuthoringProfile('column', 'CircleHollow', { Radius: 0.15, WallThickness: 0.01 });
    s().startCommand('column.place');
    act(() => { commandPointerMove(at(2, 3)); });
    assert.deepEqual(size(ghostExtent()).slice().sort((a, b) => a - b), [0.3, 0.3, 3]);
  });

  it('Width and Depth give way to the picker; Height and Rotation stay', () => {
    s().startCommand('column.place');
    const ui = render(<CommandFieldsBar />);
    assert.deepEqual(labels(ui), ['Width', 'Depth', 'Height', 'Rotation']);
    act(() => s().setAuthoringProfile('column', 'I'));
    assert.deepEqual(labels(ui), ['Height', 'Rotation']);
  });
});

describe('the Section picker in the bar (#6232 D2)', () => {
  const open = (root: HTMLElement, owner: string) => { act(() => clickEl(root.querySelector(`[data-profile-picker="${owner}"]`)!)); return advance(0); };
  const kinds = () => [...document.querySelectorAll('[data-profile-kind-button]')].map((b) => b.getAttribute('data-profile-kind-button'));

  it('lists every kind; picking I shows its fields and a preview, and is remembered by the next element', async () => {
    s().startCommand('beam.place');
    const ui = render(<BeamPlaceProfileBar ctx={ctx()} />);
    await open(ui, 'beam');
    assert.deepEqual(kinds(), ['Rectangle', 'I', 'L', 'T', 'U', 'C', 'Circle', 'RectangleHollow', 'CircleHollow']);
    act(() => clickEl(document.querySelector('[data-profile-kind-button="I"]')!));
    assert.equal(s().authoringDefaults.profiles.beam.type, 'I');
    const editor = document.querySelector('[data-profile-editor]')!;
    assert.deepEqual([...editor.querySelectorAll('input')].map((i) => i.getAttribute('aria-label')),
      ['Width in metres', 'Depth in metres', 'Web in metres', 'Flange in metres']);
    assert.ok(editor.querySelector('[data-section-preview="I"]'), 'the section preview is drawn');
    const web = [...editor.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'Web in metres')!;
    type(web, '0.012'); blur(web);
    assert.equal(authoringSection(s().authoringDefaults, 'beam')?.Type, 'I');
    assert.equal((authoringSection(s().authoringDefaults, 'beam') as { WebThickness: number }).WebThickness, 0.012);
    click(0, 0);
    click(4, 0);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, bodies()[0].expressId), { Type: 'I', OverallWidth: 0.1, OverallDepth: 0.2, WebThickness: 0.012, FlangeThickness: 0.0085 });
  });

  it('refuses a dimension the section cannot hold, and leaves the default as it was', async () => {
    s().setAuthoringProfile('beam', 'I');
    s().startCommand('beam.place');
    const ui = render(<BeamPlaceProfileBar ctx={ctx()} />);
    await open(ui, 'beam');
    const web = [...document.querySelectorAll('[data-profile-editor] input')].find((i) => i.getAttribute('aria-label') === 'Web in metres') as HTMLInputElement;
    type(web, '0.5'); blur(web);
    assert.equal((authoringSection(s().authoringDefaults, 'beam') as { WebThickness: number }).WebThickness, 0.0056);
    assert.equal(Number(web.value), 0.0056, 'the field reverts');
  });

  it('the Column bar has the picker too, and a picked kind reads on its button', async () => {
    s().startCommand('column.place');
    const ui = render(<ColumnPlaceProfileBar ctx={ctx()} />);
    assert.match(ui.querySelector('[data-profile-picker="column"]')!.textContent ?? '', /Section: Rectangle/);
    await open(ui, 'column');
    act(() => clickEl(document.querySelector('[data-profile-kind-button="CircleHollow"]')!));
    assert.match(ui.querySelector('[data-profile-picker="column"]')!.textContent ?? '', /Section: Hollow circle/);
  });

  it('stays open when the bar remounts (a longer section name makes it wrap), and only the visible copy opens', async () => {
    s().startCommand('beam.place');
    const first = render(<BeamPlaceProfileBar ctx={ctx()} />);
    await open(first, 'beam');
    assert.equal(document.querySelectorAll('[data-profile-editor]').length, 1);
    cleanup();
    // The bar in its other shape: a fresh mount, next to the offscreen measuring copy.
    const both = render(<><div><BeamPlaceProfileBar ctx={ctx()} measuring /></div><BeamPlaceProfileBar ctx={ctx()} /></>);
    await advance(0);
    assert.equal(document.querySelectorAll('[data-profile-editor]').length, 1, 'one picker, not two');
    assert.ok(both.querySelector('[data-profile-picker="beam"]'));
  });

  it('does not open by itself in the next run of the command', async () => {
    s().startCommand('beam.place');
    const ui = render(<BeamPlaceProfileBar ctx={ctx()} />);
    await open(ui, 'beam');
    cleanup();
    act(() => s().endCommand('cancel'));
    s().startCommand('beam.place');
    render(<BeamPlaceProfileBar ctx={ctx()} />);
    await advance(0);
    assert.equal(document.querySelectorAll('[data-profile-editor]').length, 0);
  });
});
