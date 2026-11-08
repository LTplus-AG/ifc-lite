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
  it(`the HUD's ${label} preset reaches the builder (#9296)`, () => {
    const ui = render(<Bar />);
    const button = [...ui.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, `the Roof HUD offers ${label}`);
    click(button); draw();
    assert.deepEqual(slopes(), flags.map(v => v * Math.PI / 6));
  });
}
it('the HUD changes one edge slope without changing the other edges (#9296)', () => {
  const ui = render(<Bar />);
  const field = ui.querySelector('[aria-label="Edge slope"]');
  assert.ok(field, 'the Roof HUD offers a per-edge slope');
  press(field, 'Enter');
  const input = ui.querySelector('input[aria-label="Edge slope"]');
  assert.ok(input); type(input as HTMLInputElement, '45'); press(input, 'Enter');
  draw(); assert.deepEqual(slopes(), [Math.PI / 4, Math.PI / 6, Math.PI / 6, Math.PI / 6]);
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
