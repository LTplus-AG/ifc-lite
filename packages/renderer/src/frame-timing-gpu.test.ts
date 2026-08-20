/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the parts of `frame-timing-gpu.ts` that are decidable without a
 * device: feature detection, query-set sizing, query-index allocation, and
 * the resolve/readback-buffer pairing arithmetic. `GpuFrameTimingRecorder`
 * itself is not instantiated here — it calls `device.createQuerySet` etc.
 * directly and has no test file, by design (see that class's doc).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  hasTimestampQueryFeature,
  queryBufferSizeBytes,
  allocatePassQueryIndices,
  pairTimestampsWithLabels,
} from './frame-timing-gpu.js';

describe('hasTimestampQueryFeature', () => {
  it('is true when the adapter feature set reports it', () => {
    assert.strictEqual(hasTimestampQueryFeature({ has: (name) => name === 'timestamp-query' }), true);
  });

  it('is false when the adapter feature set does not report it', () => {
    assert.strictEqual(hasTimestampQueryFeature({ has: () => false }), false);
  });

  it('is false, not throwing, for a null or undefined feature set', () => {
    assert.strictEqual(hasTimestampQueryFeature(null), false);
    assert.strictEqual(hasTimestampQueryFeature(undefined), false);
  });
});

describe('queryBufferSizeBytes', () => {
  it('is 2 timestamps (8 bytes each) per pass', () => {
    // 1 pass -> 2 queries (begin+end) -> 16 bytes.
    assert.strictEqual(queryBufferSizeBytes(1), 16);
  });

  it('scales linearly with an asymmetric, non-round pass count', () => {
    // 13 passes -> 26 queries -> 208 bytes.
    assert.strictEqual(queryBufferSizeBytes(13), 208);
  });

  it('is 0 for zero passes', () => {
    assert.strictEqual(queryBufferSizeBytes(0), 0);
  });
});

describe('allocatePassQueryIndices', () => {
  it('allocates the first pair (0, 1) and advances the cursor to 2', () => {
    const result = allocatePassQueryIndices(0, 8);
    assert.deepStrictEqual(result, {
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
      nextQueryIndex: 2,
    });
  });

  it('allocates a later pair from a non-zero cursor', () => {
    // Third pass in a session allowing up to 8: cursor starts at 4.
    const result = allocatePassQueryIndices(4, 8);
    assert.deepStrictEqual(result, {
      beginningOfPassWriteIndex: 4,
      endOfPassWriteIndex: 5,
      nextQueryIndex: 6,
    });
  });

  it('allocates the last available pair exactly at the maxPasses boundary', () => {
    // maxPasses=8 -> 16 query slots (indices 0..15). The 8th pass starts at
    // cursor 14 and must still succeed (14+1 = 15 < 16).
    const result = allocatePassQueryIndices(14, 8);
    assert.deepStrictEqual(result, {
      beginningOfPassWriteIndex: 14,
      endOfPassWriteIndex: 15,
      nextQueryIndex: 16,
    });
  });

  it('returns null once maxPasses passes have already been begun this frame', () => {
    // cursor=16 with maxPasses=8 (16 slots) -> exhausted.
    assert.strictEqual(allocatePassQueryIndices(16, 8), null);
  });

  it('returns null for a small, asymmetric maxPasses at its exact boundary', () => {
    // maxPasses=3 -> 6 slots (0..5). cursor=4 -> 4+1=5, not >= 6 -> still allowed.
    assert.deepStrictEqual(allocatePassQueryIndices(4, 3), {
      beginningOfPassWriteIndex: 4,
      endOfPassWriteIndex: 5,
      nextQueryIndex: 6,
    });
    // cursor=6 -> exhausted.
    assert.strictEqual(allocatePassQueryIndices(6, 3), null);
  });
});

describe('pairTimestampsWithLabels', () => {
  it('pairs each label with its (start, end) timestamps at index i*2 / i*2+1', () => {
    const labels = ['shadow', 'main', 'sky'];
    const timestamps = new BigInt64Array([10n, 25n, 25n, 900n, 900n, 950n]);
    assert.deepStrictEqual(pairTimestampsWithLabels(labels, timestamps), [
      { label: 'shadow', startNs: 10n, endNs: 25n },
      { label: 'main', startNs: 25n, endNs: 900n },
      { label: 'sky', startNs: 900n, endNs: 950n },
    ]);
  });

  it('returns an empty array for no labels, even with a non-empty buffer', () => {
    assert.deepStrictEqual(pairTimestampsWithLabels([], new BigInt64Array([1n, 2n])), []);
  });

  it('only reads as many pairs as there are labels, ignoring any trailing unused buffer slots', () => {
    // Buffer sized for maxPasses=4 (8 slots) but only 2 passes were actually
    // begun this frame — the trailing slots must not become phantom samples.
    const labels = ['main', 'shadow'];
    const timestamps = new BigInt64Array([100n, 108n, 108n, 111n, 0n, 0n, 0n, 0n]);
    assert.deepStrictEqual(pairTimestampsWithLabels(labels, timestamps), [
      { label: 'main', startNs: 100n, endNs: 108n },
      { label: 'shadow', startNs: 108n, endNs: 111n },
    ]);
  });

  describe('a malformed (short) timestamps buffer — not reachable via GpuFrameTimingRecorder.readback() today, but this function is exported to be called standalone', () => {
    it('drops a pair one element short instead of returning an undefined endNs (which crashes frameTotalMs downstream: "Cannot mix BigInt and other types")', () => {
      const labels = ['a', 'b'];
      const timestamps = new BigInt64Array([1n, 2n, 3n]); // b's endNs (index 3) is missing
      const result = pairTimestampsWithLabels(labels, timestamps);
      assert.deepStrictEqual(result, [{ label: 'a', startNs: 1n, endNs: 2n }]);
      // Every returned sample must be safe to sum in frameTotalMs without throwing.
      for (const sample of result) {
        assert.strictEqual(typeof sample.startNs, 'bigint');
        assert.strictEqual(typeof sample.endNs, 'bigint');
      }
    });

    it('drops a pair two elements short instead of silently producing NaN', () => {
      const labels = ['a', 'b'];
      const timestamps = new BigInt64Array([1n, 2n]); // b has no timestamps at all
      const result = pairTimestampsWithLabels(labels, timestamps);
      assert.deepStrictEqual(result, [{ label: 'a', startNs: 1n, endNs: 2n }]);
    });

    it('returns an empty array when there are no timestamps at all', () => {
      const labels = ['a', 'b'];
      const timestamps = new BigInt64Array([]);
      assert.deepStrictEqual(pairTimestampsWithLabels(labels, timestamps), []);
    });

    it('drops every label when the timestamps buffer is shorter than even the first pair', () => {
      const labels = ['a', 'b', 'c'];
      const timestamps = new BigInt64Array([1n]);
      assert.deepStrictEqual(pairTimestampsWithLabels(labels, timestamps), []);
    });

    it('the exact-length case (labels.length * 2 === timestamps.length) is unaffected: byte-identical to the pre-guard result', () => {
      const labels = ['shadow', 'main', 'sky'];
      const timestamps = new BigInt64Array([10n, 25n, 25n, 900n, 900n, 950n]);
      assert.deepStrictEqual(pairTimestampsWithLabels(labels, timestamps), [
        { label: 'shadow', startNs: 10n, endNs: 25n },
        { label: 'main', startNs: 25n, endNs: 900n },
        { label: 'sky', startNs: 900n, endNs: 950n },
      ]);
    });
  });
});
