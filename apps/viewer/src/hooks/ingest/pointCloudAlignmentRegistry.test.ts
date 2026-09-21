/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PointCloudAlignmentTransform } from './pointCloudAlignment.js';
import {
  applyPointCloudAlignmentToggle,
  realignRegisteredPointClouds,
  registerPointCloudAlignment,
  retargetPointCloudDecodeOrigin,
  unregisterPointCloudAlignment,
} from './pointCloudAlignmentRegistry.js';

function transform(offset: number): PointCloudAlignmentTransform {
  return {
    decodeOriginOffset: [0, 0, 0],
    decodeOriginOffsetUnit: 'mapUnit',
    alignedMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset, 0, 0, 1]),
    unalignedMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -offset, 0, 0, 1]),
  };
}

test('point-cloud GPU toggle rolls back every prior asset on a failed write (#5048)', () => {
  const first = { id: 50_481 }, second = { id: 50_482 };
  const one = transform(10), two = transform(20);
  registerPointCloudAlignment(first, one);
  registerPointCloudAlignment(second, two);
  const writes: Array<[number, number]> = [];
  const failingRenderer = {
    setPointCloudTransform(handle: { id: number }, matrix: Float32Array | Float64Array | null) {
      if (handle.id === second.id) throw new Error('GPU write failed');
      writes.push([handle.id, matrix?.[12] ?? Number.NaN]);
    },
  };
  try {
    assert.throws(() => applyPointCloudAlignmentToggle(failingRenderer, false), /GPU write failed/);
    assert.deepEqual(writes, [[first.id, -10], [first.id, 10]]);

    const retargeted: number[] = [];
    retargetPointCloudDecodeOrigin({
      setPointCloudTransform: (_handle, matrix) => retargeted.push(matrix?.[12] ?? Number.NaN),
    }, first, [5, 0, 0]);
    // A failed toggle must not have committed `enabled=false`; the following
    // stream-open rebase still emits the aligned (positive) matrix.
    assert.equal(retargeted[0], 15);
  } finally {
    unregisterPointCloudAlignment(first.id);
    unregisterPointCloudAlignment(second.id);
  }
});

test('point-cloud anchor realignment is transactional across all registered scans (#5048)', () => {
  const first = { id: 50_483 }, second = { id: 50_484 };
  registerPointCloudAlignment(first, transform(10));
  registerPointCloudAlignment(second, transform(20));
  try {
    assert.throws(() => realignRegisteredPointClouds({
      setPointCloudTransform(handle) {
        if (handle.id === second.id) throw new Error('replacement anchor failed');
      },
    }, () => transform(100)), /replacement anchor failed/);

    const observed: Array<[number, number]> = [];
    applyPointCloudAlignmentToggle({
      setPointCloudTransform(handle, matrix) { observed.push([handle.id, matrix?.[12] ?? Number.NaN]); },
    }, true);
    // The failed replacement did not publish its candidate transform.
    assert.deepEqual(observed, [[first.id, 10], [second.id, 20]]);
  } finally {
    unregisterPointCloudAlignment(first.id);
    unregisterPointCloudAlignment(second.id);
  }
});
