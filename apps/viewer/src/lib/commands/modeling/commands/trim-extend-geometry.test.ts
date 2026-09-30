/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The reach arithmetic of `element.trimExtend` (#6232 C1): where an axis meets
 * a boundary, and which end moves, in trim and extend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crossing, planReach, type ReachBoundary, type ReachTarget } from './trim-extend-geometry.js';

/** The boundary y = 0 from x = 0 to 8 (a wall axis). */
const WALL: ReachBoundary = { a: [0, 0], b: [8, 0], tMin: 0, tMax: 1, reach: 0.1 };
const LINE: ReachBoundary = { a: [0, 0], b: [1, 0], tMin: -Infinity, tMax: Infinity, reach: 0 };
const up = (x: number, y0: number, y1: number): ReachTarget => ({ p0: [x, y0, 0], dir: [0, 1, 0], length: y1 - y0 });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe('crossing (#6232 C1)', () => {
  it('finds the distance along the axis and the position along the boundary', () => {
    const c = crossing(up(4, -2, 3), WALL);
    assert.ok(typeof c !== 'string');
    assert.ok(near(c.at, 2) && near(c.t, 0.5));
    assert.deepEqual(c.point, [4, 0]);
  });

  it('a boundary along the axis never crosses it', () => {
    assert.equal(crossing({ p0: [0, 1, 0], dir: [1, 0, 0], length: 4 }, WALL), 'parallel');
  });

  it('a vertical member has no plan axis', () => {
    assert.equal(crossing({ p0: [1, 1, 0], dir: [0, 0, 1], length: 3 }, WALL), 'vertical');
  });

  it('a rising beam is crossed on its plan projection, and `at` counts along the 3D axis', () => {
    // 45 degrees up along +y: plan length is 1/sqrt2 of the axis length.
    const s = Math.SQRT1_2;
    const c = crossing({ p0: [4, -2, 0], dir: [0, s, s], length: 6 }, WALL);
    assert.ok(typeof c !== 'string');
    assert.ok(near(c.at, 2 / s));
  });
});

describe('planReach: extend (#6232 C1)', () => {
  it('lengthens the end nearest the click to the boundary', () => {
    const plan = planReach(up(4, 0, 3), { ...WALL, a: [0, 4], b: [8, 4] }, 'extend', 3, 0.05, false);
    assert.ok(plan.ok);
    assert.equal(plan.end, 'end');
    assert.equal(plan.op, 'extend');
    assert.ok(near(plan.stop[1], 4) && near(plan.start[1], 0) && near(plan.moved, 1) && near(plan.length, 4));
  });

  it('extends the START when the boundary is behind it and the click is nearer it', () => {
    const plan = planReach(up(4, 2, 5), WALL, 'extend', 0, 0.05, false);
    assert.ok(plan.ok);
    assert.equal(plan.end, 'start');
    assert.ok(near(plan.start[1], 0) && near(plan.stop[1], 5) && near(plan.moved, 2));
  });

  it('refuses when the boundary lies past the other end than the clicked one', () => {
    const plan = planReach(up(4, 2, 5), WALL, 'extend', 3, 0.05, false);
    assert.deepEqual(plan, { ok: false, reason: 'otherEnd' });
  });

  it('refuses an element that already crosses the boundary, pointing at Trim', () => {
    assert.deepEqual(planReach(up(4, -2, 3), WALL, 'extend', 2, 0.05, false), { ok: false, reason: 'crossesInside' });
  });
});

describe('planReach: trim (#6232 C1)', () => {
  it('cuts back the side that was clicked, keeping the other', () => {
    const far = planReach(up(4, -2, 3), WALL, 'trim', 4.5, 0.05, false);
    assert.ok(far.ok);
    assert.equal(far.end, 'end');
    assert.ok(near(far.stop[1], 0) && near(far.start[1], -2) && near(far.moved, -3) && near(far.length, 2));
    const back = planReach(up(4, -2, 3), WALL, 'trim', 0.5, 0.05, false);
    assert.ok(back.ok);
    assert.equal(back.end, 'start');
    assert.ok(near(back.start[1], 0) && near(back.stop[1], 3) && near(back.length, 3));
  });

  it('refuses an element that stops short, pointing at Extend', () => {
    assert.deepEqual(planReach(up(4, 1, 3), WALL, 'trim', 1, 0.05, false), { ok: false, reason: 'notReached' });
  });

  it('refuses a trim that would leave less than the minimum length', () => {
    assert.deepEqual(planReach(up(4, -0.02, 3), WALL, 'trim', 3, 0.05, false), { ok: false, reason: 'tooShort' });
  });
});

describe('planReach: the boundary and joins (#6232 C1)', () => {
  it('refuses when the lines cross past the end of a finite boundary, and takes any point of a line', () => {
    assert.deepEqual(planReach(up(12, -2, 3), WALL, 'trim', 2, 0.05, false), { ok: false, reason: 'boundaryShort' });
    assert.ok(planReach(up(12, -2, 3), LINE, 'trim', 2, 0.05, false).ok);
  });

  it('a crossing within the boundary wall\'s half thickness past its end still counts', () => {
    assert.ok(planReach(up(8.05, -2, 3), WALL, 'trim', 2, 0.05, false).ok);
    assert.equal(planReach(up(8.2, -2, 3), WALL, 'trim', 2, 0.05, false).ok, false);
  });

  it('an end already on the boundary is a join without a move, else nothing to do', () => {
    const target = up(4, 0, 3);
    assert.deepEqual(planReach(target, WALL, 'extend', 0, 0.05, false), { ok: false, reason: 'alreadyThere' });
    const join = planReach(target, WALL, 'trim', 0, 0.05, true);
    assert.ok(join.ok);
    assert.equal(join.end, 'start');
    assert.ok(near(join.moved, 0));
  });

  it('an oblique boundary moves the end to where the axes meet', () => {
    const diagonal: ReachBoundary = { a: [0, 0], b: [4, 4], tMin: 0, tMax: 1, reach: 0 };
    const plan = planReach({ p0: [2, -2, 0], dir: [0, 1, 0], length: 1 }, diagonal, 'extend', 1, 0.05, false);
    assert.ok(plan.ok);
    assert.ok(near(plan.stop[0], 2) && near(plan.stop[1], 2));
  });
});
