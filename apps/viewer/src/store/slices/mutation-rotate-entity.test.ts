/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8446: the viewer's `rotateEntity` turns a wall whose IfcAxis2Placement3D
 * leaves Axis and RefDirection implicit (`$`), as files from other tools do.
 * It used to refuse. The defaults are materialised and turned as one undo
 * step, and that one Undo puts the `$` record back.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { readAttributes } from '@/lib/placement-core.js';
import { WALL, WALL_MODEL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';

const store = () => useViewerStore.getState();
const TILTED = (step: string) =>
  step.replace('#54=IFCDIRECTION((0.,0.,1.));', '#54=IFCDIRECTION((0.6,0.,0.8));').replace('#55=IFCDIRECTION((1.,0.,0.));', '#55=IFCDIRECTION((0.8,0.,-0.6));');
const IMPLICIT = (step: string) => step.replace('#52=IFCAXIS2PLACEMENT3D(#53,#54,#55);', '#52=IFCAXIS2PLACEMENT3D(#53,$,$);');

function close(actual: readonly number[] | undefined, expected: readonly number[], what: string): void {
  assert.ok(actual, `${what}: no value`);
  expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 1e-9, `${what}: [${actual.join(', ')}] != [${expected.join(', ')}]`));
}

describe('rotateEntity with an implicit RefDirection (#8446)', () => {
  beforeEach(() => seedRectangleWall(WALL_UNITS[0].unit, WALL_UNITS[0].scale, IMPLICIT));

  it('materialises and turns the RefDirection as one undo step', () => {
    const view = store().mutationViews.get(WALL_MODEL)!;
    assert.equal(view.getMutations().length, 0);
    close(store().readEntityRotation(WALL_MODEL, WALL)?.refDirection, [1, 0, 0], 'implicit frame');

    const result = store().rotateEntity(WALL_MODEL, WALL, Math.PI / 2);
    assert.deepEqual(result.ok && Math.abs(result.newYawZ - Math.PI / 2) < 1e-12, true, JSON.stringify(result));
    const turned = store().readEntityRotation(WALL_MODEL, WALL);
    assert.ok(turned && Math.abs(turned.yawZ - Math.PI / 2) < 1e-12);
    close(turned.refDirection, [0, 1, 0], 'turned frame');
    assert.deepEqual(view.getNewEntities().map((e) => e.type).sort(), ['IfcDirection', 'IfcDirection']);

    store().undo(WALL_MODEL);
    assert.equal(store().undoStacks.get(WALL_MODEL)!.length, 0, 'one Ctrl+Z reverts the whole rotate');
    assert.deepEqual(view.getNewEntities(), [], 'the materialised IfcDirections are gone');
    const placement = readAttributes(store().models.get(WALL_MODEL)!.ifcDataStore!, view, store().storeEditors.get(WALL_MODEL)!, 52);
    assert.equal(placement?.[1], null, 'Axis is $ again');
    assert.equal(placement?.[2], null, 'RefDirection is $ again');
    close(store().readEntityRotation(WALL_MODEL, WALL)?.refDirection, [1, 0, 0], 'restored frame');
  });
});

describe('rotateEntity with an explicit tilted RefDirection', () => {
  beforeEach(() => seedRectangleWall(WALL_UNITS[0].unit, WALL_UNITS[0].scale, TILTED));

  it('keeps the in-plane length and slope of the direction it turns', () => {
    const result = store().rotateEntity(WALL_MODEL, WALL, Math.PI / 2);
    assert.equal(result.ok, true, JSON.stringify(result));
    close(store().readEntityRotation(WALL_MODEL, WALL)?.refDirection, [0, 0.8, -0.6], 'turned tilted frame');
    assert.deepEqual(store().mutationViews.get(WALL_MODEL)!.getNewEntities(), [], 'the explicit RefDirection is edited in place');
  });
});
