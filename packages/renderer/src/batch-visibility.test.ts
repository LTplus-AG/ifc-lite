/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BatchVisibilityCache, canFilterOnGpu, classifyBatch, type PartlyVisibleBatch } from './batch-visibility.js';
import type { BatchedMesh } from './types.js';

const COLOR: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const b = (expressIds: number[]): BatchedMesh => ({ id: 1, colorKey: 'k', expressIds, color: COLOR }) as unknown as BatchedMesh;
const visible = (v: ReturnType<typeof classifyBatch>): number[] => [...(v as PartlyVisibleBatch).visibleIds].sort((x, y) => x - y);

// One classifier for the colour and shadow passes (#2670 Phase 2b, #10264 S2),
// with the isEntityVisible rules: empty isolation hides everything, an absent
// one nothing, and hiding wins.
describe('classifyBatch', () => {
  it('is "all" when no filter is active (both nullish and empty-hidden)', () => {
    assert.equal(classifyBatch(b([1, 2, 3]), undefined, undefined), 'all');
    assert.equal(classifyBatch(b([1, 2, 3]), new Set(), null), 'all');
  });

  it('is "none" when every element is hidden, and under an empty isolate set', () => {
    assert.equal(classifyBatch(b([1, 2]), new Set([1, 2]), undefined), 'none');
    assert.equal(classifyBatch(b([1, 2]), undefined, new Set()), 'none');
  });

  it('is "all" when the isolate set covers every element', () => {
    assert.equal(classifyBatch(b([1, 2]), undefined, new Set([1, 2])), 'all');
  });

  it('counts repeated visible piece entries without treating them as partly hidden (#10636)', () => {
    assert.equal(classifyBatch(b([7, 7]), new Set([99]), null), 'all');
    assert.deepEqual(visible(classifyBatch(b([7, 7, 8]), new Set([8]), null)), [7]);
  });

  it('keeps the visible part of a partly hidden or partly isolated batch', () => {
    assert.deepEqual(visible(classifyBatch(b([1, 2, 3]), new Set([2]), undefined)), [1, 3]);
    assert.deepEqual(visible(classifyBatch(b([1, 2, 3]), undefined, new Set([2, 3]))), [2, 3]);
    assert.deepEqual(visible(classifyBatch(b([1, 2]), new Set([1]), new Set([1, 2]))), [2], 'hiding wins over isolation');
  });

  it('gives the visible part the entries and colour X-Ray and routing read', () => {
    const part = classifyBatch(b([1, 2, 3]), new Set([2]), undefined) as PartlyVisibleBatch;
    assert.deepEqual([...part.expressIds].sort(), [1, 3]);
    assert.equal(part.color, COLOR);
  });
});

describe('BatchVisibilityCache', () => {
  it('returns the same part for one epoch, so per-object X-Ray caches hit, and recomputes on a new epoch', () => {
    const cache = new BatchVisibilityCache();
    const batch = b([1, 2]);
    const hidden = new Set([1]);
    const first = cache.classify(batch, 3, hidden, null);
    hidden.add(2);
    assert.equal(cache.classify(batch, 3, hidden, null), first, 'the epoch, not the set, decides a recompute');
    assert.equal(cache.classify(batch, 4, hidden, null), 'none');
  });

  it('judges a batch again when it gains entries within one epoch (a compact page grows while a model streams)', () => {
    const cache = new BatchVisibilityCache();
    const page = b([1, 2]);
    const hidden = new Set([3]);
    assert.equal(cache.classify(page, 7, hidden, null), 'all');
    page.expressIds.push(3); // a hidden mesh joins the page after it was judged all visible
    const part = cache.classify(page, 7, hidden, null) as PartlyVisibleBatch;
    assert.deepEqual([...part.expressIds].sort(), [1, 2]);
    assert.equal(cache.classify(page, 7, hidden, null), part, 'and is cached again at its new size');
  });
});

describe('canFilterOnGpu', () => {
  it('needs the table and a lane anchor (entries within one 2^24 page)', () => {
    assert.equal(canFilterOnGpu(b([5, 9]), true), true);
    assert.equal(canFilterOnGpu(b([5, 9]), false), false, 'table could not take this frame\'s sets');
    assert.equal(canFilterOnGpu(b([5, 0x01000005]), true), false, 'ids span two pages: the lane cannot name them');
  });
});
