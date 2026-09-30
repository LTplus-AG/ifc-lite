/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The faces push / pull offers (#6232 C4): where each sits on the element,
 * which way it points, which dimension it sets and how much of the pointer's
 * travel it takes; the ghost the drag draws; and the drag's own arithmetic
 * (screen axis, snapping).
 */

import '@/lib/placement-edit.boot';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { asExpressIdRef, readAttributes } from '@/lib/placement-core';
import { resolveSlabEditChain } from '@/lib/slab-edit';
import { setElementSize } from '@/store/slices/mutation-element-size';
import { draggedSize, faceScreenAxis } from './push-pull-drag.js';
import { MIN_SIZE, levelHeights, snapSize } from './push-pull-snap.js';
import { readPushPullTarget, type PushPullFace, type PushPullTarget } from './push-pull-target.js';

const s = () => useViewerStore.getState();
const close = (a: readonly number[], b: readonly number[], message: string) => {
  assert.equal(a.length, b.length, message);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${message}: ${a} vs ${b}`));
};
const created = (made: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  return made.expressId;
};
const target = (id: number): PushPullTarget => {
  const t = readPushPullTarget(s(), MODEL_ID, id);
  assert.ok(t, `#${id} has push / pull faces`);
  return t;
};
const face = (t: PushPullTarget, id: PushPullFace['id']): PushPullFace => t.faces.find((f) => f.id === id)!;

beforeEach(async () => { await seedModelingSession(); });
afterEach(() => { s().exitModelWorkspace(); });

describe('push / pull faces (#6232 C4)', () => {
  it('a wall offers its top (height) and both sides (thickness, grown about the axis)', () => {
    const t = target(created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 })));
    assert.deepEqual(t.faces.map((f) => f.id), ['wall.top', 'wall.sideLeft', 'wall.sideRight']);
    const top = face(t, 'wall.top');
    close(top.origin, [2, 0, 3], 'top face centre');
    close(top.normal, [0, 0, 1], 'top normal');
    assert.equal(top.gain, 1);
    const left = face(t, 'wall.sideLeft'), right = face(t, 'wall.sideRight');
    close(left.origin, [2, 0.1, 1.5], 'left face on the wall side');
    close(left.normal, [0, 1, 0], 'left normal');
    close(right.normal, [0, -1, 0], 'right normal');
    // The wall thickens about its axis: the pulled face travels half the thickness change.
    assert.equal(left.gain, 2);
    assert.deepEqual(left.patch(0.4), { kind: 'wall', thickness: 0.4 });
    assert.deepEqual(top.patch(3.4), { kind: 'wall', height: 3.4 });
  });

  it('a slab offers its far face; a column both ends, each holding the other still', () => {
    const slab = target(created(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 })));
    const far = face(slab, 'slab.far');
    close(far.origin, [2, 1.5, 0.2], 'top of the slab, at its centre');
    close(far.normal, [0, 0, 1], 'slab normal');
    assert.equal(far.size, 0.2);

    const column = target(created(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 })));
    close(face(column, 'linear.end').origin, [2, 2, 3], 'column head');
    close(face(column, 'linear.start').origin, [2, 2, 0], 'column foot');
    close(face(column, 'linear.start').normal, [0, 0, -1], 'the foot points down');
    assert.deepEqual(face(column, 'linear.end').patch(4), { kind: 'linear', length: 4, fixed: 'start' });
    assert.deepEqual(face(column, 'linear.start').patch(4), { kind: 'linear', length: 4, fixed: 'end' });
  });

  it('the ghost shows the element with the dragged face moved, the far side held', () => {
    const wall = target(created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 })));
    const taller = wall.prism(face(wall, 'wall.top'), 3.5)!;
    assert.deepEqual([taller.z0, taller.z1], [0, 3.5]);
    const thicker = wall.prism(face(wall, 'wall.sideLeft'), 0.6)!;
    const ys = thicker.outline.map((p) => p[1]);
    close([Math.min(...ys), Math.max(...ys)], [-0.3, 0.3], 'the wall grew both ways about its axis');

    const column = target(created(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 1], Width: 0.3, Depth: 0.3, Height: 2 })));
    const footPulled = column.prism(face(column, 'linear.start'), 3)!;
    close([footPulled.z0, footPulled.z1], [0, 3], 'pulling the foot down keeps the head at 3 m');
    const headPulled = column.prism(face(column, 'linear.end'), 3)!;
    close([headPulled.z0, headPulled.z1], [1, 4], 'pulling the head up keeps the foot at 1 m');
  });

  it('a slab extruded downward is pulled by its underside and keeps its top where it is', () => {
    const slab = created(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    // Flip the extrusion: ExtrudedDirection (0, 0, -1) hangs the depth below the profile plane.
    const { dataStore, view } = { dataStore: s().models.get(MODEL_ID)!.ifcDataStore!, view: s().mutationViews.get(MODEL_ID)! };
    const chain = resolveSlabEditChain(dataStore, view, s().storeEditors.get(MODEL_ID)!, slab, 1)!;
    const solid = readAttributes(dataStore, view, s().storeEditors.get(MODEL_ID)!, chain.extrudedSolidId)!;
    const direction = asExpressIdRef(solid[2]);
    assert.ok(direction !== null, 'the builder writes an explicit ExtrudedDirection');
    s().setPositionalAttribute(MODEL_ID, direction, 0, [0, 0, -1]);

    const t = target(slab);
    const far = face(t, 'slab.far');
    close(far.origin, [2, 1.5, -0.2], 'the underside');
    close(far.normal, [0, 0, -1], 'points down');
    assert.equal(setElementSize(useViewerStore, MODEL_ID, slab, far.patch(0.5)).ok, true);
    const after = resolveSlabEditChain(dataStore, view, s().storeEditors.get(MODEL_ID)!, slab, 1)!;
    close([after.baseElevation!, after.thickness], [-0.5, 0.5], 'the slab grew downward');
    close([after.baseElevation! + after.thickness], [0], 'its top is where it was');
  });

  it('offers nothing for an element with no plain extruded layout', () => {
    assert.equal(readPushPullTarget(s(), MODEL_ID, 130), null, 'the imported mesh wall has no dimension to pull');
    assert.equal(readPushPullTarget(s(), MODEL_ID, 100 /* hung slab is a flat extrusion */)?.faces.length, 1);
    assert.equal(readPushPullTarget(s(), MODEL_ID, 120), null, 'a tilted roof slab is not pulled along Z');
  });
});

describe('the drag (#6232 C4)', () => {
  // An orthographic view from the front: 100 px per metre, render +Y up the screen.
  const project = (p: { x: number; y: number; z: number }) => ({ x: p.x * 100, y: -p.y * 100 });

  it('reads the pointer travel along the face normal in screen space, so a vertical face is draggable', () => {
    const wall = target(created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 })));
    const top = face(wall, 'wall.top');
    const axis = faceScreenAxis(wall, top, project)!;
    close([axis.x, axis.y], [0, -100], 'a metre up is 100 px up');
    close([draggedSize(top, axis, 0, -50)], [3.5], 'half a metre up asks for a 3.5 m wall');
    close([draggedSize(top, axis, 30, 0)], [3], 'sideways travel does nothing');
    // The side face's wall grows about its axis, so half a metre of face travel is a metre more wall.
    const left = face(wall, 'wall.sideLeft');
    assert.equal(faceScreenAxis(wall, left, project), null, 'a face pointing into the screen cannot be dragged, only typed');
    close([draggedSize(left, { x: 100, y: 0 }, 50, 0)], [0.2 + 0.5 * 2], 'the wall gains twice the face travel');
  });

  it('snaps a vertical face to the next floor level, else to a step, and Alt or the S toggle turn it off', () => {
    const wall = target(created(s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2 })));
    const top = face(wall, 'wall.top');
    const levels = levelHeights(s(), wall);
    close(levels, [3], 'the storey above is 3 m up');
    assert.deepEqual(snapSize(top, 2.93, { enabled: true, fine: false, levels }), { size: 3, kind: 'level' });
    assert.deepEqual(snapSize(top, 2.62, { enabled: true, fine: false, levels }), { size: 2.6, kind: 'step' });
    assert.deepEqual(snapSize(top, 2.627, { enabled: true, fine: true, levels }), { size: 2.63, kind: 'step' });
    assert.deepEqual(snapSize(top, 2.93, { enabled: false, fine: false, levels }), { size: 2.93, kind: null });
    assert.equal(snapSize(top, -4, { enabled: false, fine: false, levels }).size, MIN_SIZE, 'never below the minimum');
    // A side face has no level to land on.
    assert.equal(snapSize(face(wall, 'wall.sideLeft'), 2.93, { enabled: true, fine: false, levels }).kind, 'step');
  });
});
