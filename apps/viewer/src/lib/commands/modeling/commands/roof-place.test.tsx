/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID } from '@/test/modeling-session-fixture';
import { cleanup, render, click, type, press } from '@/test/render';
import { SlabPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import { useCommandRuntime } from '../runtime';
import { commandPointerMove, commandPointerDown, getCommandRuntime } from '../runtime';
import { setRequestRemesh } from '../transaction';
import type { SlabPlaceGesture } from './slab-place-geometry';
import '../builtin';

let restore: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  useViewerStore.getState().setAuthoringDefaults({ slabClass: 'roof', slabMode: 'rectangle' });
  useViewerStore.getState().startCommand('slab.place');
});
afterEach(() => { restore(); useViewerStore.getState().exitModelWorkspace(); cleanup(); });
function Bar() {
  const rt = useCommandRuntime();
  return <SlabPlaceBar gesture={rt.gesture as SlabPlaceGesture} ctx={rt.ctx!} />;
}
async function renderBar() {
  let ui!: HTMLElement;
  await act(async () => { ui = render(<Bar />); });
  return ui;
}
function draw() {
  for (const local of [[0, 0], [10, 8]] as const) act(() => {
    const p = { local, winner: null, guides: [], locked: false };
    commandPointerMove(p); commandPointerDown(p);
  });
}
function slopes() {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  const roof = view.getNewEntities().find(e => e.type.toUpperCase() === 'IFCROOF' && !view.isDeleted(e.expressId));
  assert.ok(roof, 'drawing commits a roof (#9296)');
  const recorded = view.getPropertyValue(roof.expressId, 'IfcLite_RoofFootprint', 'EdgeSlopes');
  assert.equal(typeof recorded, 'string', 'the Roof tool calls the footprint builder (#9296)');
  return JSON.parse(String(recorded)) as number[];
}
it('Roof defaults to a 30 degree hip built from the drawn footprint (#9296)', () => {
  draw(); assert.deepEqual(slopes(), Array(4).fill(Math.PI / 6));
});
for (const [label, flags] of [['Gable', [1, 0, 1, 0]], ['Mono-pitch', [1, 0, 0, 0]]] as const) {
  it(`the HUD's ${label} preset reaches the builder (#9296)`, async () => {
    const ui = await renderBar();
    const button = [...ui.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, `the Roof HUD offers ${label}`);
    click(button); draw();
    assert.deepEqual(slopes(), flags.map(v => v * Math.PI / 6));
  });
}
it('the HUD changes one edge slope without changing the other edges (#9296)', async () => {
  const ui = await renderBar();
  const field = ui.querySelector('[aria-label="Edge slope"]');
  assert.ok(field, 'the Roof HUD offers a per-edge slope');
  press(field, 'Enter');
  const input = ui.querySelector('input[aria-label="Edge slope"]');
  assert.ok(input); type(input as HTMLInputElement, '45'); press(input, 'Enter');
  draw(); assert.deepEqual(slopes(), [Math.PI / 4, Math.PI / 6, Math.PI / 6, Math.PI / 6]);
});

function allRoofSlopes(): number[][] {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities().filter(e => e.type.toUpperCase() === 'IFCROOF' && !view.isDeleted(e.expressId))
    .map(e => JSON.parse(String(view.getPropertyValue(e.expressId, 'IfcLite_RoofFootprint', 'EdgeSlopes'))) as number[]);
}
it('the next roof does not inherit the previous footprint\'s edge slopes or edge, but keeps preset and pitch (#9296)', async () => {
  const ui = await renderBar();
  const gable = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Gable');
  assert.ok(gable); click(gable);
  const field = ui.querySelector('[aria-label="Edge slope"]');
  assert.ok(field); press(field, 'Enter');
  const input = ui.querySelector('input[aria-label="Edge slope"]');
  assert.ok(input); type(input as HTMLInputElement, '45'); press(input, 'Enter');
  draw();
  const next = (getCommandRuntime().gesture as SlabPlaceGesture).roof;
  assert.deepEqual({ edge: next.edge, overrides: next.overrides, preset: next.preset, pitch: next.pitch }, { edge: 0, overrides: {}, preset: 'gable', pitch: 30 });
  draw();
  const [first, second] = allRoofSlopes();
  assert.deepEqual(first, [Math.PI / 4, 0, Math.PI / 6, 0]);
  assert.deepEqual(second, [Math.PI / 6, 0, Math.PI / 6, 0], 'the second footprint uses the preset, not the first roof\'s edge override');
});
it('switching the outline mode drops footprint-specific edge slopes (#9296)', async () => {
  const ui = await renderBar();
  const field = ui.querySelector('[aria-label="Edge slope"]');
  assert.ok(field); press(field, 'Enter');
  const input = ui.querySelector('input[aria-label="Edge slope"]');
  assert.ok(input); type(input as HTMLInputElement, '45'); press(input, 'Enter');
  assert.deepEqual((getCommandRuntime().gesture as SlabPlaceGesture).roof.overrides, { 0: 45 });
  const polygon = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Polygon');
  assert.ok(polygon); click(polygon);
  const roof = (getCommandRuntime().gesture as SlabPlaceGesture).roof;
  assert.deepEqual({ edge: roof.edge, overrides: roof.overrides, pitch: roof.pitch }, { edge: 0, overrides: {}, pitch: 30 });
});

it('the hip preview has the builder’s pitched ridge rather than a flat prism (#9296)', () => {
  act(() => {
    commandPointerMove({ local: [0, 0], winner: null, guides: [], locked: false });
    commandPointerDown({ local: [0, 0], winner: null, guides: [], locked: false });
    commandPointerMove({ local: [10, 8], winner: null, guides: [], locked: false });
  });
  const rt = getCommandRuntime();
  assert.ok(rt.ctx?.workplane);
  const ghosts = rt.command!.ghost?.(rt.gesture, rt.ctx) ?? [];
  assert.equal(ghosts.length, 4, 'one ghost plane per sloped footprint edge');
  let highest = -Infinity;
  for (const mesh of ghosts) for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = rt.ctx.workplane.renderToLocal([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    highest = Math.max(highest, p[2]);
  }
  assert.ok(Math.abs(highest - (4 * Math.tan(Math.PI / 6) + 0.3 / Math.cos(Math.PI / 6))) < 1e-5);
});

function enterRoofValue(ui: HTMLElement, label: string, value: string) {
  const field = ui.querySelector(`[aria-label="${label}"]`);
  assert.ok(field, `the Roof HUD offers ${label} (#9296)`);
  press(field, 'Enter');
  const input = ui.querySelector(`input[aria-label="${label}"]`);
  assert.ok(input); type(input as HTMLInputElement, value); press(input, 'Enter');
}
function previewBounds() {
  const rt = getCommandRuntime();
  assert.ok(rt.ctx?.workplane);
  const points = (rt.command!.ghost?.(rt.gesture, rt.ctx) ?? []).flatMap(mesh => {
    const points = [];
    for (let i = 0; i < mesh.positions.length; i += 3) points.push(rt.ctx!.workplane!.renderToLocal([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]));
    return points;
  });
  return { minX: Math.min(...points.map(p => p[0])), maxZ: Math.max(...points.map(p => p[2])) };
}
it('typed Pitch updates every sloped edge live, preserving unsloped edges, and commits in one undo (#9296)', async () => {
  const ui = await renderBar();
  enterRoofValue(ui, 'Edge slope', '0');
  act(() => {
    commandPointerDown({ local: [0, 0], winner: null, guides: [], locked: false });
    commandPointerMove({ local: [10, 8], winner: null, guides: [], locked: false });
  });
  const before = previewBounds();
  const depth = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
  enterRoofValue(ui, 'Pitch', '45');
  assert.ok(previewBounds().maxZ > before.maxZ + 1);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
  act(() => commandPointerDown({ local: [10, 8], winner: null, guides: [], locked: false }));
  assert.deepEqual(slopes(), [0, Math.PI / 4, Math.PI / 4, Math.PI / 4]);
  act(() => useViewerStore.getState().undo(MODEL_ID));
  assert.deepEqual(allRoofSlopes(), [], 'one undo removes the whole footprint roof');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
});
it('typed Overhang extends the live eave and persists through the footprint builder (#9296)', async () => {
  const ui = await renderBar();
  act(() => {
    commandPointerDown({ local: [0, 0], winner: null, guides: [], locked: false });
    commandPointerMove({ local: [10, 8], winner: null, guides: [], locked: false });
  });
  enterRoofValue(ui, 'Overhang', '0.6');
  assert.ok(Math.abs(previewBounds().minX + 0.6) < 1e-5);
  act(() => commandPointerDown({ local: [10, 8], winner: null, guides: [], locked: false }));
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  const roof = view.getNewEntities().find(e => e.type.toUpperCase() === 'IFCROOF')!;
  assert.equal(view.getPropertyValue(roof.expressId, 'IfcLite_RoofFootprint', 'Overhang'), 0.6);
});
