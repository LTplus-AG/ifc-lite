/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `slab.place` (charter #6232, M2.2): a rectangle (two corners, typed sides,
 * Shift squares it) or a polygon (a click per corner; Enter, a double-click
 * or a click back on the first corner closes it), written as IfcSlab,
 * IfcRoof or IfcPlate by the in-store builder. Each outline is ONE undo step
 * and asks the wasm re-mesh service for its geometry.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click as clickEl, press, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { authoredBodies } from '@/test/authored-body';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { SlabPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { SLAB_PLACE } from './slab-place.js';
import type { SlabPlaceGesture } from './slab-place-geometry.js';

const at = (x: number, y: number, shift = false): SnapResult => ({
  local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift, alt: false },
});
const gesture = () => getCommandRuntime().gesture as SlabPlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number, shift = false) => act(() => { commandPointerMove(at(x, y, shift)); commandPointerDown(at(x, y, shift)); });
const round = (v: number) => +v.toFixed(6);

const SLAB_LIKE = new Set(['IFCSLAB', 'IFCROOF', 'IFCPLATE']);

/** Every live slab-like overlay element: its class, and its footprint as storey-local plan points. */
function slabs(): { cls: string; outline: Vec2[]; z: number; thickness: number }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
  const ref = (v: unknown) => byId.get(Number(String(v).slice(1)))!;
  return view.getNewEntities()
    .filter((e) => SLAB_LIKE.has(e.type.toUpperCase()) && !view.isDeleted(e.expressId))
    .map((e) => {
      const origin = s.readEntityPosition(MODEL_ID, e.expressId)!;
      // Product → IfcProductDefinitionShape → IfcShapeRepresentation → IfcExtrudedAreaSolid → profile.
      const shape = ref(e.attributes[6]);
      const rep = ref((shape.attributes[2] as string[])[0]);
      const solid = ref((rep.attributes[3] as string[])[0]);
      const profile = ref(solid.attributes[0]);
      const thickness = solid.attributes[3] as number;
      let local: Vec2[];
      if (profile.type.toUpperCase() === 'IFCRECTANGLEPROFILEDEF') {
        const w = profile.attributes[3] as number, d = profile.attributes[4] as number;
        local = [[0, 0], [w, 0], [w, d], [0, d]];
      } else {
        const polyline = ref(profile.attributes[2]);
        local = (polyline.attributes[0] as string[]).map((p) => ref(p).attributes[0] as unknown as Vec2);
        if (local.length > 1 && local[0][0] === local.at(-1)![0] && local[0][1] === local.at(-1)![1]) local = local.slice(0, -1);
      }
      return {
        cls: e.type.toUpperCase(),
        outline: local.map(([x, y]) => [round(origin[0] + x), round(origin[1] + y)] as Vec2),
        z: round(origin[2]),
        thickness: round(thickness),
      };
    });
}

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setAuthoringDefaults({ slabMode: 'rectangle', slabClass: 'slab' });
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
  useViewerStore.getState().startCommand('slab.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('slab.place: rectangle (#6232 M2.2)', () => {
  it('two corners make one IfcSlab, one undo step, re-meshed through wasm', () => {
    const before = undoDepth();
    click(4, 3);
    assert.deepEqual(slabs(), [], 'the first click only sets a corner');
    click(1, 1); // the opposite corner may lie on any side
    const [slab] = slabs();
    assert.equal(slab.cls, 'IFCSLAB');
    assert.deepEqual(slab.outline, [[1, 1], [4, 1], [4, 3], [1, 3]]);
    assert.equal(slab.thickness, 0.3, 'the slab default thickness');
    assert.equal(remeshed.length, 1, 'the commit asks the wasm re-mesh service for true geometry');
    assert.equal(remeshed[0].cause, 'created');
    assert.equal(gesture().points.length, 0, 'ready for the next slab');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(slabs(), [], 'one undo removes the whole slab');
    assert.equal(undoDepth(), before);
  });

  it('a typed Width locks that side; the cursor still picks the quadrant', () => {
    const ui = render(<CommandFieldsBar />);
    click(2, 2);
    act(() => { commandPointerMove(at(-1, 5)); });
    press(document.body, '6');
    const input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Width');
    type(input, '6');
    press(input, 'Enter');
    assert.deepEqual(slabs()[0].outline, [[-4, 2], [2, 2], [2, 5], [-4, 5]], 'six wide towards -x, the cursor gives the depth');
  });

  // Review of #6396: `Math.abs(v) || null` dropped a typed 0, so Enter built a
  // slab sized by the cursor instead of refusing the width the user typed.
  it('a typed Width of 0 holds, and Enter refuses the rectangle instead of using the cursor', () => {
    const ui = render(<CommandFieldsBar />);
    click(0, 0);
    act(() => { commandPointerMove(at(3, 2)); });
    press(document.body, '0');
    const input = ui.querySelector('input') as HTMLInputElement;
    type(input, '0');
    press(input, 'Enter');
    assert.equal(gesture().width, 0, 'the typed zero is kept as the lock');
    assert.deepEqual(slabs(), [], 'nothing is built from the cursor');
  });

  it('tabbing past an empty Width before the first corner locks nothing', () => {
    render(<CommandFieldsBar />);
    press(document.body, 'Tab');
    press(document.querySelector('input') as HTMLInputElement, 'Tab');
    assert.equal(gesture().width, null, 'the shown placeholder 0 is not a lock');
    click(0, 0);
    click(2, 1);
    assert.deepEqual(slabs()[0].outline, [[0, 0], [2, 0], [2, 1], [0, 1]]);
  });

  it('Shift squares the rectangle on its longer side', () => {
    click(0, 0);
    click(3, 1, true);
    assert.deepEqual(slabs()[0].outline, [[0, 0], [3, 0], [3, 3], [0, 3]]);
  });

  it('refuses a rectangle without area, and writes nothing', () => {
    const before = undoDepth();
    click(0, 0);
    click(5, 0);
    assert.deepEqual(slabs(), []);
    assert.equal(undoDepth(), before);
  });

  it('draws on the session storey: the upper storey writes at its own level', () => {
    useViewerStore.getState().exitModelWorkspace();
    useViewerStore.getState().enterModelWorkspace({ storeyId: UPPER_STOREY, command: 'slab.place' });
    click(0, 0);
    click(2, 2);
    const s = useViewerStore.getState();
    const [slab] = slabs();
    assert.equal(slab.z, 0, 'storey-local: the builder places it relative to the storey');
    const id = s.mutationViews.get(MODEL_ID)!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCSLAB')!.expressId;
    assert.equal(s.models.get(MODEL_ID)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(id), UPPER_STOREY);
    assert.notEqual(UPPER_STOREY, STOREY);
  });
});

describe('slab.place: polygon (#6232 M2.2)', () => {
  beforeEach(() => {
    useViewerStore.getState().setAuthoringDefaults({ slabMode: 'polygon' });
    useViewerStore.getState().startCommand('slab.place');
  });

  const L_SHAPE: Vec2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];

  it('Enter closes a concave outline into one slab, one undo step', () => {
    const before = undoDepth();
    for (const [x, y] of L_SHAPE) click(x, y);
    assert.deepEqual(slabs(), []);
    press(document.body, 'Enter');
    assert.deepEqual(slabs().map((s) => s.outline), [L_SHAPE]);
    assert.equal(undoDepth(), before + 1);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(slabs(), []);
  });

  it('a click back on the first corner closes it', () => {
    for (const [x, y] of [[0, 0], [3, 0], [3, 3]] as const) click(x, y);
    click(0, 0);
    assert.deepEqual(slabs().map((s) => s.outline), [[[0, 0], [3, 0], [3, 3]]]);
  });

  it('a double-click closes it at the double-clicked corner', () => {
    click(0, 0);
    click(3, 0);
    click(3, 3); // the first click of the double-click adds the corner …
    act(() => { commandDoubleClick(at(3, 3)); }); // … the second closes
    assert.deepEqual(slabs().map((s) => s.outline), [[[0, 0], [3, 0], [3, 3]]]);
  });

  it('needs three corners; Backspace drops the last one', () => {
    click(0, 0);
    click(3, 0);
    press(document.body, 'Enter');
    assert.deepEqual(slabs(), [], 'two corners are refused');
    click(3, 3);
    press(document.body, 'Backspace');
    assert.deepEqual(gesture().points, [[0, 0], [3, 0]]);
  });

  it('switching to Rectangle in the bar drops the half-drawn outline', () => {
    const ui = render(<SlabPlaceBar gesture={gesture()} ctx={ctx()} />);
    click(0, 0);
    click(3, 0);
    const rectangle = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Rectangle')!;
    clickEl(rectangle);
    assert.equal(gesture().mode, 'rectangle');
    assert.deepEqual(gesture().points, []);
    assert.equal(useViewerStore.getState().authoringDefaults.slabMode, 'rectangle', 'the next slab starts as a rectangle too');
  });
});

describe('slab.place: class (#6232 M2.2)', () => {
  for (const [cls, entity, thickness] of [['roof', 'IFCROOF', 0.3], ['plate', 'IFCPLATE', 0.02]] as const) {
    it(`the ${cls} segment writes an ${entity} with the ${cls} thickness`, () => {
      const ui = render(<SlabPlaceBar gesture={gesture()} ctx={ctx()} />);
      const segment = [...ui.querySelectorAll('button')].find((b) => b.textContent?.toLowerCase() === cls)!;
      clickEl(segment);
      assert.equal(useViewerStore.getState().authoringDefaults.slabClass, cls);
      click(0, 0);
      click(2, 3);
      const [made] = slabs();
      assert.equal(made.cls, entity);
      assert.equal(made.thickness, thickness);
      useViewerStore.getState().undo(MODEL_ID);
      assert.deepEqual(slabs(), [], `one undo removes the ${cls}`);
    });
  }

  it('a typed Thickness edits the class default the commit builds with', () => {
    useViewerStore.getState().setAuthoringDefaults({ slabClass: 'roof' });
    const ui = render(<CommandFieldsBar />);
    press(document.body, 'Tab'); // Width
    press(document.body, 'Tab'); // Depth
    press(document.body, 'Tab'); // Thickness
    const input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Thickness');
    type(input, '0.45');
    press(input, 'Tab'); // applies it and moves on
    click(0, 0);
    click(1, 1);
    assert.equal(slabs()[0].thickness, 0.45);
  });
});

// Lane A2 (#6232): every class the bar offers, in both outline modes, writes
// its own IFC class with an extruded body, as one undo step.
describe('slab.place: every class in both outline modes (#6232 A2)', () => {
  const OUTLINES = {
    rectangle: { clicks: [[0, 0], [2, 3]] as Vec2[], profile: 'IFCRECTANGLEPROFILEDEF' },
    polygon: { clicks: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] as Vec2[], profile: 'IFCARBITRARYCLOSEDPROFILEDEF' },
  } as const;
  const CLASSES = [['slab', 'IFCSLAB', 0.3], ['roof', 'IFCROOF', 0.3], ['plate', 'IFCPLATE', 0.02]] as const;

  for (const [mode, { clicks, profile }] of Object.entries(OUTLINES) as [keyof typeof OUTLINES, (typeof OUTLINES)[keyof typeof OUTLINES]][]) {
    for (const [cls, entity, thickness] of CLASSES) {
      it(`a ${mode} ${cls} is one ${entity} with a swept-solid ${profile} body, one undo step`, () => {
        useViewerStore.getState().setAuthoringDefaults({ slabMode: mode, slabClass: cls });
        // Dimensions outlive a test (the slice is session state): pin this class's.
        useViewerStore.getState().setAuthoringDims(cls, { Thickness: thickness });
        useViewerStore.getState().startCommand('slab.place');
        const before = undoDepth();
        for (const [x, y] of clicks) click(x, y);
        if (mode === 'polygon') press(document.body, 'Enter');
        const bodies = authoredBodies(MODEL_ID, [...SLAB_LIKE]);
        assert.deepEqual(bodies.map(({ expressId: _id, ...b }) => b), [{
          cls: entity, identifier: 'Body', representationType: 'SweptSolid',
          solid: 'IFCEXTRUDEDAREASOLID', profile, depth: thickness,
        }]);
        assert.equal(undoDepth(), before + 1, 'one transaction');
        useViewerStore.getState().undo(MODEL_ID);
        assert.deepEqual(authoredBodies(MODEL_ID, [...SLAB_LIKE]), [], `one undo removes the ${cls}`);
        assert.equal(undoDepth(), before);
      });
    }
  }
});

describe('slab.place ghost (#6232 M2.2)', () => {
  it('previews the rectangle the commit writes, as a prism of the class thickness', () => {
    assert.deepEqual(SLAB_PLACE.ghost!(gesture(), ctx()), [], 'nothing before the first corner');
    click(1, 1);
    act(() => { commandPointerMove(at(4, 3)); });
    const [ghost] = SLAB_PLACE.ghost!(gesture(), ctx());
    assert.ok(ghost);
    const plane = ctx().workplane!;
    const local = [];
    for (let i = 0; i < ghost.positions.length; i += 3) {
      local.push(plane.renderToLocal([ghost.positions[i], ghost.positions[i + 1], ghost.positions[i + 2]]));
    }
    const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]), zs = local.map((p) => p[2]);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)].map(round), [1, 4]);
    assert.deepEqual([Math.min(...ys), Math.max(...ys)].map(round), [1, 3]);
    assert.deepEqual([Math.min(...zs), Math.max(...zs)].map(round), [0, 0.3]);
    click(4, 3);
    const [slab] = slabs();
    assert.deepEqual(slab.outline, [[1, 1], [4, 1], [4, 3], [1, 3]], 'the commit lands where the ghost was');
  });
});
