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

/**
 * `assert.deepStrictEqual` compares prototypes, and the by-label accumulators
 * are deliberately null-prototype (see `passDurationsMs`), so an expectation
 * written as a plain `{}` literal would not match. Building the expectation
 * the same way keeps the comparison exactly as strict — and additionally pins
 * that the null prototype is still there.
 */
function bareMap<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

describe('passDurationsMs — single pass', () => {
  it('converts one pass to its millisecond duration under its label', () => {
    const samples: PassTimingSample[] = [{ label: 'main', startNs: 1_000_000n, endNs: 5_500_000n }];
    assert.deepStrictEqual(passDurationsMs(samples), bareMap({ main: 4.5 }));
  });
});

describe('passDurationsMs — multiple passes in one frame', () => {
  it('keeps distinct labels separate', () => {
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 2_100_000n },
      { label: 'main', startNs: 2_100_000n, endNs: 9_800_000n },
      { label: 'sky', startNs: 9_800_000n, endNs: 10_050_000n },
    ];
    assert.deepStrictEqual(passDurationsMs(samples), bareMap({ shadow: 2.1, main: 7.7, sky: 0.25 }));
  });

  it('sums two passes sharing one label (e.g. repeated shadow cascades)', () => {
    const samples: PassTimingSample[] = [
      { label: 'shadow', startNs: 0n, endNs: 1_250_000n }, // 1.25ms
      { label: 'shadow', startNs: 1_250_000n, endNs: 3_400_000n }, // 2.15ms
    ];
    assert.deepStrictEqual(passDurationsMs(samples), bareMap({ shadow: 3.4 }));
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
    assert.deepStrictEqual(report.passes, bareMap({}));
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

// A pass label is caller-chosen free text (`PassTimingSample.label`), and the
// per-label accumulators are keyed by it directly. On a plain `{}` the
// inherited `Object.prototype` names are live: `totals['__proto__'] = n` is a
// setter call that is silently DROPPED (no own property is created, so the
// label vanishes from the report), and `totals['constructor'] ?? 0` reads the
// inherited `Object` function, so `+ ms` string-concatenates into
// `"function Object() { [native code] }4.5"` instead of summing. This is a
// correctness boundary, not a security one: a report that silently loses or
// corrupts a pass is worse than one that omits it loudly. `Object.create(null)`
// removes the inherited names entirely, so every label is just a key.
describe('passDurationsMs — labels that collide with Object.prototype', () => {
  it('records a __proto__ pass as an own key instead of silently dropping it', () => {
    const totals = passDurationsMs([{ label: '__proto__', startNs: 1_000_000n, endNs: 5_500_000n }]);
    assert.ok(
      Object.hasOwn(totals, '__proto__'),
      'a __proto__-labelled pass must be an own key, not a swallowed prototype assignment',
    );
    assert.strictEqual(totals['__proto__'], 4.5);
    // And it must be a real entry in the enumerable shape — that is what
    // aggregateFrameTimings' `Object.entries()` walk actually consumes.
    assert.deepStrictEqual(Object.entries(totals), [['__proto__', 4.5]]);
  });

  it('sums two __proto__ passes rather than losing both', () => {
    const totals = passDurationsMs([
      { label: '__proto__', startNs: 0n, endNs: 1_250_000n },
      { label: '__proto__', startNs: 1_250_000n, endNs: 3_400_000n },
    ]);
    assert.strictEqual(totals['__proto__'], 3.4);
  });

  it('sums a constructor-labelled pass as a number, not a concatenated function source', () => {
    const totals = passDurationsMs([{ label: 'constructor', startNs: 0n, endNs: 2_000_000n }]);
    assert.strictEqual(
      totals.constructor,
      2,
      'the inherited Object constructor must not be read as the running total',
    );
  });

  it('leaves ordinary labels untouched alongside a hostile one', () => {
    const totals = passDurationsMs([
      { label: 'main', startNs: 0n, endNs: 8_000_000n },
      { label: '__proto__', startNs: 8_000_000n, endNs: 10_000_000n },
    ]);
    assert.strictEqual(totals.main, 8);
    assert.strictEqual(totals['__proto__'], 2);
  });
});

describe('aggregateFrameTimings — labels that collide with Object.prototype', () => {
  // `report.passes` is accumulated by the same by-label-key pattern, so it
  // carries the same defect INDEPENDENTLY of passDurationsMs':
  // `passes['__proto__'] = stats` on a plain object sets the PROTOTYPE (the
  // value is an object, so the setter accepts it) and creates no own key at
  // all — the pass disappears from the aggregated report even once
  // passDurationsMs itself is fixed.
  it('keeps a __proto__ pass label in report.passes', () => {
    const report = aggregateFrameTimings('gpu-queries', [
      [{ label: '__proto__', startNs: 0n, endNs: 2_000_000n }],
      [{ label: '__proto__', startNs: 0n, endNs: 4_000_000n }],
    ]);
    assert.ok(Object.hasOwn(report.passes, '__proto__'), 'the label must survive into report.passes');
    assert.strictEqual(report.passes['__proto__'].count, 2);
    assert.strictEqual(report.passes['__proto__'].min, 2);
    assert.strictEqual(report.passes['__proto__'].max, 4);
    assert.strictEqual(report.frame.count, 2, 'the frame totals are unaffected either way');
  });
});
