/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VisibilityEpochTracker } from './visibility-epoch.js';

describe('VisibilityEpochTracker', () => {
  it('starts at version 0 and stays there while no filtering is passed', () => {
    const t = new VisibilityEpochTracker();
    assert.strictEqual(t.update(undefined, undefined), 0);
    assert.strictEqual(t.update(undefined, null), 0);
    assert.strictEqual(t.update(new Set(), undefined), 0, 'empty hidden set == no hidden filter');
  });

  it('bumps when a hidden filter appears and when it disappears', () => {
    const t = new VisibilityEpochTracker();
    assert.strictEqual(t.update(new Set([1, 2]), undefined), 1);
    assert.strictEqual(t.update(undefined, undefined), 2);
  });

  it('detects IN-PLACE mutation of the same hidden Set reference', () => {
    const t = new VisibilityEpochTracker();
    const hidden = new Set([1, 2]);
    const v1 = t.update(hidden, undefined);
    assert.strictEqual(t.update(hidden, undefined), v1, 'unchanged content, same ref: stable');
    hidden.add(3);
    const v2 = t.update(hidden, undefined);
    assert.ok(v2 > v1, 'in-place add must bump the version');
    hidden.delete(3);
    assert.ok(t.update(hidden, undefined) > v2, 'in-place delete must bump the version');
  });

  it('detects an equal-size in-place swap (delete one id, add another)', () => {
    const t = new VisibilityEpochTracker();
    const hidden = new Set([5, 6]);
    const v1 = t.update(hidden, undefined);
    hidden.delete(5);
    hidden.add(7); // same size, different content
    assert.ok(t.update(hidden, undefined) > v1);
  });

  it('does NOT bump for a fresh Set with identical content', () => {
    const t = new VisibilityEpochTracker();
    const v1 = t.update(new Set([1, 2, 3]), new Set([9]));
    assert.strictEqual(t.update(new Set([3, 2, 1]), new Set([9])), v1);
  });

  it('detects in-place mutation of the isolated Set', () => {
    const t = new VisibilityEpochTracker();
    const isolated = new Set([10, 11]);
    const v1 = t.update(undefined, isolated);
    isolated.delete(11);
    assert.ok(t.update(undefined, isolated) > v1);
  });

  it('treats an EMPTY isolated set as different from null (isolate-nothing hides everything)', () => {
    const t = new VisibilityEpochTracker();
    const v1 = t.update(undefined, new Set());
    assert.ok(v1 > 0, 'empty isolation is a real filter');
    assert.strictEqual(t.update(undefined, new Set()), v1, 'stays stable while empty isolation holds');
    assert.ok(t.update(undefined, null) > v1, 'dropping isolation is a change');
  });

  it('snapshots content: later mutation of a set passed earlier cannot corrupt history', () => {
    const t = new VisibilityEpochTracker();
    const hidden = new Set([1]);
    const v1 = t.update(hidden, undefined);
    hidden.add(2);
    const v2 = t.update(hidden, undefined);
    assert.ok(v2 > v1);
    // Passing a fresh set matching the CURRENT content must not bump.
    assert.strictEqual(t.update(new Set([1, 2]), undefined), v2);
  });

  it('hide -> show-all -> hide same set -> different set bumps each transition', () => {
    const t = new VisibilityEpochTracker();
    const a = new Set([1, 2]);
    const v1 = t.update(a, undefined);
    const v2 = t.update(undefined, undefined);
    const v3 = t.update(new Set([1, 2]), undefined);
    const v4 = t.update(new Set([3]), undefined);
    assert.ok(v1 < v2 && v2 < v3 && v3 < v4);
  });
});
