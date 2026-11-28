/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolationFor } from './repositionIsolation.js';

/** Regression for #11504: a fresh Set per pointer move kept the screen corner grid from ever settling. */
describe('Reposition isolation set (#11504)', () => {
  const allowed = new Set([1, 2, 3, 4]);

  it('narrows the eligible entities to the isolated ones', () => {
    const isolationFor = createIsolationFor(allowed);
    assert.deepEqual([...isolationFor(new Set([2, 4, 9]))].sort(), [2, 4]);
  });

  it('returns the eligible set itself when nothing is isolated', () => {
    assert.equal(createIsolationFor(allowed)(null), allowed);
  });

  it('returns the SAME set on every call while the isolation is unchanged', () => {
    const isolationFor = createIsolationFor(allowed);
    const isolated = new Set([1, 2]);
    assert.equal(isolationFor(isolated), isolationFor(isolated));
  });

  it('#11753 tracks eligible additions on the same isolation set', () => {
    const isolationFor = createIsolationFor(allowed);
    const isolated = new Set([1]);
    assert.deepEqual([...isolationFor(isolated)], [1]);
    isolated.add(2);
    const expanded = isolationFor(isolated);
    assert.deepEqual([...expanded], [1, 2]);
    assert.equal(isolationFor(isolated), expanded);
  });

  it('#11753 replaces eligible ID 1 with 3 when isolation size stays constant', () => {
    const isolationFor = createIsolationFor(allowed);
    const isolated = new Set([1, 2]);
    assert.deepEqual([...isolationFor(isolated)], [1, 2]);
    isolated.delete(1);
    isolated.add(3);
    const swapped = isolationFor(isolated);
    assert.deepEqual([...swapped], [2, 3]);
    assert.equal(isolationFor(isolated), swapped);
  });

  it('returns a new set when the isolation changes', () => {
    const isolationFor = createIsolationFor(allowed);
    const first = isolationFor(new Set([1, 2]));
    const second = isolationFor(new Set([3]));
    assert.notEqual(first, second);
    assert.deepEqual([...second], [3]);
  });
});
