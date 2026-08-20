/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  decideTimingMode,
  passDurationsMs,
  frameTotalMs,
  aggregateFrameTimings,
  type PassTimingSample,
} from './frame-timing.js';

describe('decideTimingMode', () => {
  it('is disabled when not enabled, regardless of feature support', () => {
    assert.strictEqual(decideTimingMode({ enabled: false, hasTimestampQueryFeature: true }), 'disabled');
    assert.strictEqual(decideTimingMode({ enabled: false, hasTimestampQueryFeature: false }), 'disabled');
  });

  it('uses GPU queries when enabled and the feature is present', () => {
    assert.strictEqual(decideTimingMode({ enabled: true, hasTimestampQueryFeature: true }), 'gpu-queries');
  });

  it('falls back to CPU timing when enabled, feature absent, fallback allowed (default)', () => {
    assert.strictEqual(decideTimingMode({ enabled: true, hasTimestampQueryFeature: false }), 'cpu-fallback');
    assert.strictEqual(
      decideTimingMode({ enabled: true, hasTimestampQueryFeature: false, allowCpuFallback: true }),
      'cpu-fallback',
    );
  });

  it('is disabled (not silently reporting anything) when enabled, feature absent, fallback explicitly refused', () => {
    assert.strictEqual(
      decideTimingMode({ enabled: true, hasTimestampQueryFeature: false, allowCpuFallback: false }),
      'disabled',
    );
  });

  it('the feature-absent path never throws', () => {
    assert.doesNotThrow(() => decideTimingMode({ enabled: true, hasTimestampQueryFeature: false }));
  });
});

describe('passDurationsMs — single pass', () => {
  it('converts one pass to its millisecond duration under its label', () => {
    const samples: PassTimingSample[] = [{ label: 'main', startNs: 1_000_000n, endNs: 5_500_000n }];
    assert.deepStrictEqual(passDurationsMs(samples), { main: 4.5 });
  });
});

describe('passDurationsMs — multiple passes in one frame', () => {
  it('keeps distinct labels separate', () => {
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 2_100_000n },
      { label: 'main', startNs: 2_100_000n, endNs: 9_800_000n },
      { label: 'sky', startNs: 9_800_000n, endNs: 10_050_000n },
    ];
    assert.deepStrictEqual(passDurationsMs(samples), { shadow: 2.1, main: 7.7, sky: 0.25 });
  });

  it('sums two passes sharing one label (e.g. repeated shadow cascades)', () => {
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 1_250_000n }, // 1.25ms
      { label: 'shadow', startNs: 1_250_000n, endNs: 3_400_000n }, // 2.15ms
    ];
    assert.deepStrictEqual(passDurationsMs(samples), { shadow: 3.4 });
  });
});

describe('frameTotalMs', () => {
  it('sums every pass duration for the frame total', () => {
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 2_100_000n },
      { label: 'main', startNs: 2_100_000n, endNs: 9_800_000n },
      { label: 'sky', startNs: 9_800_000n, endNs: 10_050_000n },
    ];
    // 2.1 + 7.7 + 0.25
    assert.strictEqual(frameTotalMs(samples), 10.05);
  });

  it('is 0 for a frame with zero recorded passes (not an empty-sample marker — a real frame that measured nothing)', () => {
    assert.strictEqual(frameTotalMs([]), 0);
  });

  it('a non-monotonic (end < start) pass contributes 0, not a negative amount, to the frame total', () => {
    // A GPU clock reset (see nsToMs's doc) can produce end < start for one
    // pass among otherwise-valid ones. frameTotalMs sums nsToMs's raw
    // output directly (it never routes through computeDurationStats), so
    // this is the exact path that a guard placed only in
    // computeDurationStats would miss.
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 2_100_000n }, // 2.1ms
      { label: 'main', startNs: 9_800_000n, endNs: 3_400_000n }, // corrupted: end < start
      { label: 'sky', startNs: 9_800_000n, endNs: 10_050_000n }, // 0.25ms
    ];
    // 2.1 + 0 (clamped) + 0.25, not 2.1 + (-6.4) + 0.25
    assert.strictEqual(frameTotalMs(samples), 2.35);
  });
});

describe('aggregateFrameTimings — feature-absent / disabled path', () => {
  it('reports mode disabled with empty-sample stats when there is no history', () => {
    const report = aggregateFrameTimings('disabled', []);
    assert.strictEqual(report.mode, 'disabled');
    assert.strictEqual(report.frame.count, 0);
    assert.deepStrictEqual(report.passes, {});
  });
});

describe('aggregateFrameTimings — zero frames with a mode set', () => {
  it('does not divide by zero or report a misleading 0 for gpu-queries mode with no recorded frames', () => {
    const report = aggregateFrameTimings('gpu-queries', []);
    assert.strictEqual(report.mode, 'gpu-queries');
    assert.deepStrictEqual(report.frame, {
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
      mean: null,
    });
  });
});

describe('aggregateFrameTimings — multiple frames', () => {
  it('aggregates per-frame totals and per-label stats across frames, including a label missing from one frame', () => {
    const frames: PassTimingSample[][] = [
      [
        { label: 'shadow', startNs: 0n, endNs: 2_000_000n }, // 2ms
        { label: 'main', startNs: 2_000_000n, endNs: 10_000_000n }, // 8ms
      ],
      [
        // 'shadow' absent this frame (e.g. shadows disabled mid-session) —
        // must not be treated as a 0ms sample for the 'shadow' label.
        { label: 'main', startNs: 0n, endNs: 12_500_000n }, // 12.5ms
      ],
      [
        { label: 'shadow', startNs: 0n, endNs: 3_400_000n }, // 3.4ms
        { label: 'main', startNs: 3_400_000n, endNs: 9_900_000n }, // 6.5ms
      ],
    ];
    const report = aggregateFrameTimings('gpu-queries', frames);

    assert.strictEqual(report.frame.count, 3);
    // frame totals: 10, 12.5, 9.9
    assert.strictEqual(report.frame.min, 9.9);
    assert.strictEqual(report.frame.max, 12.5);

    assert.strictEqual(report.passes.shadow.count, 2); // only 2 frames had a shadow pass
    assert.strictEqual(report.passes.shadow.min, 2);
    assert.strictEqual(report.passes.shadow.max, 3.4);

    assert.strictEqual(report.passes.main.count, 3);
    assert.strictEqual(report.passes.main.max, 12.5);
    // No monotonicity violations anywhere in this fixture.
    assert.strictEqual(report.invalidSampleCount, 0);
  });
});

describe('aggregateFrameTimings — invalidSampleCount (non-monotonic GPU timestamp pairs)', () => {
  it('counts a single negative-delta sample among otherwise-valid frames, and still clamps its contribution to 0 rather than poisoning min/mean', () => {
    const frames: PassTimingSample[][] = [
      [
        { label: 'shadow', startNs: 0n, endNs: 2_000_000n }, // 2ms, valid
        { label: 'main', startNs: 8_000_000n, endNs: 1_500_000n }, // corrupted: end < start
      ],
      [{ label: 'shadow', startNs: 0n, endNs: 3_150_000n }], // 3.15ms, valid
    ];
    const report = aggregateFrameTimings('gpu-queries', frames);

    assert.strictEqual(report.invalidSampleCount, 1);
    // frame totals: (2 + 0 clamped) = 2, and 3.15 — never a negative min.
    assert.strictEqual(report.frame.min, 2);
    assert.strictEqual(report.frame.max, 3.15);
    assert.ok((report.frame.mean ?? NaN) >= 0);
  });

  it('counts every sample when all are non-monotonic, and reports clamped-0 stats rather than a fabricated negative verdict', () => {
    const frames: PassTimingSample[][] = [
      [{ label: 'main', startNs: 5_000_000n, endNs: 1_000_000n }], // corrupted
      [{ label: 'main', startNs: 9_876_543n, endNs: 1_234_567n }], // corrupted, non-round
    ];
    const report = aggregateFrameTimings('gpu-queries', frames);

    assert.strictEqual(report.invalidSampleCount, 2);
    assert.strictEqual(report.frame.min, 0);
    assert.strictEqual(report.frame.max, 0);
    assert.strictEqual(report.frame.mean, 0);
  });

  it('a legitimate zero-delta pass is not counted as invalid', () => {
    const frames: PassTimingSample[][] = [[{ label: 'main', startNs: 42n, endNs: 42n }]];
    const report = aggregateFrameTimings('gpu-queries', frames);
    assert.strictEqual(report.invalidSampleCount, 0);
    assert.strictEqual(report.frame.min, 0);
  });

  it('the empty-history case is unaffected: invalidSampleCount is 0 and stats stay the explicit EMPTY_STATS shape', () => {
    const report = aggregateFrameTimings('disabled', []);
    assert.strictEqual(report.invalidSampleCount, 0);
    assert.deepStrictEqual(report.frame, {
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
      mean: null,
    });
  });
});
