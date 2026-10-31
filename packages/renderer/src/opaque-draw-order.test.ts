/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eyeToBoxDistanceSq, sortOpaqueFrontToBack } from './opaque-draw-order.js';

type Box = { id: string; bounds?: { min: [number, number, number]; max: [number, number, number] } };
const box = (id: string, min: [number, number, number], max: [number, number, number]): Box => ({ id, bounds: { min, max } });
const eye = { x: 0, y: 0, z: 0 };

describe('front-to-back opaque order', () => {
  it('measures to the nearest point of the box, zero inside it', () => {
    assert.equal(eyeToBoxDistanceSq(eye, [-1, -1, -1], [1, 1, 1]), 0);
    assert.equal(eyeToBoxDistanceSq(eye, [3, 0, 0], [5, 1, 1]), 9);
    assert.equal(eyeToBoxDistanceSq(eye, [3, 4, -1], [9, 9, 1]), 25);
  });

  it('draws the nearest batch first, a model-sized one around the eye before small far ones', () => {
    const batches = [
      box('far', [100, 0, 0], [101, 1, 1]),
      box('near', [2, 0, 0], [3, 1, 1]),
      box('around-eye', [-500, -500, -500], [500, 500, 500]),
      box('mid', [10, 0, 0], [11, 1, 1]),
    ];
    assert.deepEqual(sortOpaqueFrontToBack(batches, eye).map((b) => b.id), ['around-eye', 'near', 'mid', 'far']);
  });

  it('keeps submission order for ties and puts unbounded batches last, in their order', () => {
    const batches: Box[] = [{ id: 'u1' }, box('a', [1, 0, 0], [2, 1, 1]), { id: 'u2' }, box('b', [1, 5, 0], [2, 6, 1]), box('a2', [1, -3, 0], [2, 1, 1])];
    // a and a2 are both 1 away (a2 touches the eye's y); b is farther.
    assert.deepEqual(sortOpaqueFrontToBack(batches, eye).map((b) => b.id), ['a', 'a2', 'b', 'u1', 'u2']);
  });
});
