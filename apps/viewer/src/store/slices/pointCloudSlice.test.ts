/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud classification visibility state (#1783): the 256-bit
 * class mask invariants (full LAS code range, unsigned words, invalid
 * input recovery) and the per-asset histogram add/remove lifecycle
 * that keeps the classes checklist consistent with loaded scans.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ALL_POINT_CLOUD_CLASSES_VISIBLE,
  POINT_CLOUD_CLASS_MASK_WORDS,
  createPointCloudSlice,
  isPointCloudClassVisible,
  type PointCloudSlice,
} from './pointCloudSlice.js';

describe('PointCloudSlice class mask (#1783)', () => {
  let state: PointCloudSlice;
  let setState: (partial: Partial<PointCloudSlice> | ((state: PointCloudSlice) => Partial<PointCloudSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      const updates = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...updates };
    };
    state = createPointCloudSlice(setState, () => state, {} as never);
  });

  it('toggle covers the full LAS code range, including user-defined 64..255', () => {
    state.togglePointCloudClass(2);
    state.togglePointCloudClass(200);

    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 2), false);
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 200), false);
    // Neighbours in the same words are untouched.
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 3), true);
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 201), true);

    // Toggling again restores the all-visible state bit-for-bit.
    state.togglePointCloudClass(2);
    state.togglePointCloudClass(200);
    assert.deepStrictEqual(state.pointCloudClassMask, [...ALL_POINT_CLOUD_CLASSES_VISIBLE]);
  });

  it('toggle clamps out-of-range class ids instead of corrupting the mask', () => {
    state.togglePointCloudClass(999); // clamps to 255
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 255), false);
    state.togglePointCloudClass(-5); // clamps to 0
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 0), false);
    assert.strictEqual(state.pointCloudClassMask.length, POINT_CLOUD_CLASS_MASK_WORDS);
  });

  it('setPointCloudClassMask sanitizes malformed word arrays', () => {
    // Short array: missing words default to all-visible; NaN resets;
    // negative words coerce into the unsigned range (same policy the
    // old 32-bit setter had, so GPU uniforms never see garbage).
    state.setPointCloudClassMask([Number.NaN, -1, 0]);
    assert.strictEqual(state.pointCloudClassMask.length, POINT_CLOUD_CLASS_MASK_WORDS);
    assert.strictEqual(state.pointCloudClassMask[0], 0xFFFFFFFF);
    assert.strictEqual(state.pointCloudClassMask[1], 0xFFFFFFFF);
    assert.strictEqual(state.pointCloudClassMask[2], 0);
    assert.strictEqual(state.pointCloudClassMask[7], 0xFFFFFFFF);
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 64), false);
    assert.strictEqual(isPointCloudClassVisible(state.pointCloudClassMask, 96), true);
  });

  it('per-asset histograms accumulate independently and drop on removal', () => {
    // A streamed scan (renderer handle 3) and the inline IFCx assets
    // both report counts; removing the scan must leave IFCx intact.
    state.setPointCloudClassCounts(3, { 2: 1000, 6: 50 });
    state.setPointCloudClassCounts('ifcx', { 2: 10 });

    assert.deepStrictEqual(state.pointCloudClassCounts['3'], { 2: 1000, 6: 50 });
    assert.deepStrictEqual(state.pointCloudClassCounts.ifcx, { 2: 10 });

    state.setPointCloudClassCounts(3, null);
    assert.strictEqual(state.pointCloudClassCounts['3'], undefined);
    assert.deepStrictEqual(state.pointCloudClassCounts.ifcx, { 2: 10 });

    // Removing an unknown key is a no-op, not a crash.
    state.setPointCloudClassCounts(99, null);
    assert.deepStrictEqual(state.pointCloudClassCounts.ifcx, { 2: 10 });
  });
});
