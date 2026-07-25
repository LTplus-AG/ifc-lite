/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  registerPointCloudScanCache,
  addPointsToScanCache,
  getPointCloudScanSample,
  removePointCloudScanCache,
  clearAllPointCloudScanCaches,
} from './pointCloudScanCache.js';

function makeChunk(count: number, startAt = 0): { positions: Float32Array; pointCount: number } {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = startAt + i;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
  }
  return { positions, pointCount: count };
}

describe('pointCloudScanCache', () => {
  beforeEach(() => {
    clearAllPointCloudScanCaches();
  });

  it('returns null for an unregistered handle', () => {
    assert.strictEqual(getPointCloudScanSample(999), null);
  });

  it('retains every point when under capacity', () => {
    registerPointCloudScanCache(1, 100);
    addPointsToScanCache(1, makeChunk(10));
    const sample = getPointCloudScanSample(1);
    assert.ok(sample);
    assert.strictEqual(sample!.count, 10);
    assert.strictEqual(sample!.seen, 10);
  });

  it('never exceeds capacity across many chunks (reservoir sampling)', () => {
    registerPointCloudScanCache(2, 50);
    for (let c = 0; c < 20; c++) {
      addPointsToScanCache(2, makeChunk(100, c * 100));
    }
    const sample = getPointCloudScanSample(2);
    assert.ok(sample);
    assert.strictEqual(sample!.count, 50);
    assert.strictEqual(sample!.seen, 2000);
    assert.strictEqual(sample!.positions.length, 50 * 3);
  });

  it('carries colours and classifications alongside positions', () => {
    registerPointCloudScanCache(3, 10);
    const chunk = {
      positions: new Float32Array([1, 2, 3]),
      colors: new Float32Array([1, 0, 0]),
      classifications: new Uint8Array([5]),
      pointCount: 1,
    };
    addPointsToScanCache(3, chunk);
    const sample = getPointCloudScanSample(3);
    assert.ok(sample);
    assert.deepStrictEqual(Array.from(sample!.colors!.slice(0, 3)), [255, 0, 0]);
    assert.strictEqual(sample!.classifications![0], 5);
  });

  it('removePointCloudScanCache drops the sample', () => {
    registerPointCloudScanCache(4, 10);
    addPointsToScanCache(4, makeChunk(5));
    assert.ok(getPointCloudScanSample(4));
    removePointCloudScanCache(4);
    assert.strictEqual(getPointCloudScanSample(4), null);
  });

  it('grows buffers geometrically instead of allocating full capacity up front', () => {
    // Capacity above the initial 65_536-slot allocation: the positions
    // buffer must start small and still retain every point across the
    // growth boundary with values intact.
    registerPointCloudScanCache(6, 200_000);
    const before = getPointCloudScanSample(6)!;
    assert.ok(
      before.positions.length <= 65_536 * 3,
      `expected initial allocation <= 65536 slots, got ${before.positions.length / 3}`,
    );
    addPointsToScanCache(6, makeChunk(100_000));
    const sample = getPointCloudScanSample(6)!;
    assert.strictEqual(sample.count, 100_000);
    assert.ok(sample.positions.length >= sample.count * 3);
    // Spot-check values across the growth boundary (points are x = index).
    assert.strictEqual(sample.positions[0], 0);
    assert.strictEqual(sample.positions[65_536 * 3], 65_536);
    assert.strictEqual(sample.positions[99_999 * 3], 99_999);
  });

  it('backfills neutral grey for points retained before the first coloured chunk', () => {
    registerPointCloudScanCache(7, 10);
    addPointsToScanCache(7, { positions: new Float32Array([1, 2, 3]), pointCount: 1 });
    addPointsToScanCache(7, {
      positions: new Float32Array([4, 5, 6]),
      colors: new Float32Array([1, 0, 0]),
      pointCount: 1,
    });
    const sample = getPointCloudScanSample(7)!;
    // Pre-colour point reads neutral grey (200), not zero-filled black.
    assert.deepStrictEqual(Array.from(sample.colors!.slice(0, 3)), [200, 200, 200]);
    assert.deepStrictEqual(Array.from(sample.colors!.slice(3, 6)), [255, 0, 0]);
  });

  it('re-registering the same handle resets the reservoir', () => {
    registerPointCloudScanCache(5, 10);
    addPointsToScanCache(5, makeChunk(10));
    assert.strictEqual(getPointCloudScanSample(5)!.count, 10);
    registerPointCloudScanCache(5, 10);
    assert.strictEqual(getPointCloudScanSample(5)!.count, 0);
  });
});
