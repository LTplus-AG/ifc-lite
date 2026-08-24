/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The language `isWhollyNumeric` accepts, and the reason it is a hand-written
 * scan rather than the obvious regex.
 *
 * The oracle here is deliberately NOT a hand-listed table: a table is written
 * by whoever changed the scan, so it shares their blind spot. It is the regex
 * the scan replaced -- a separate mechanism deciding the same language -- run
 * over an exhaustively generated corpus rather than a list anyone chose.
 */
import { describe, it, expect } from 'vitest';
import { isWhollyNumeric } from './numeric-literal.js';

/**
 * The spec. Deliberately still here after the implementation stopped using it:
 * it states the accepted language in one line, and a deliberate change to that
 * language has to be made here too. It is not used in production because it
 * backtracks (see the timing test below).
 */
const SPEC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Every string up to 4 characters over the alphabet the language is built
 *  from, plus the characters most likely to be wrongly accepted. */
function corpus(): string[] {
  const alpha = ['', '+', '-', '.', '0', '1', '9', 'e', 'E', ',', ' ', '\t', '\n', 'x', '１', '١'];
  const out = new Set<string>();
  for (const a of alpha) for (const b of alpha) for (const c of alpha) for (const d of alpha) {
    out.add(a + b + c + d);
  }
  return [...out];
}

describe('isWhollyNumeric accepts exactly the documented language', () => {
  const all = corpus();

  it('the corpus is actually populated (an empty sweep proves nothing)', () => {
    expect(all.length).toBeGreaterThan(50_000);
  });

  it('agrees with the spec regex on every string in it', () => {
    const disagree = all.filter((v) => SPEC_RE.test(v) !== isWhollyNumeric(v)).map((v) => JSON.stringify(v));
    expect(disagree).toEqual([]);
  });

  it('the sweep can fail: a deliberately narrower language is caught', () => {
    // Without this, an empty corpus or an always-agreeing oracle would also
    // report zero disagreements and the test above would pin nothing.
    const narrower = (v: string) => /^[+-]?\d+$/.test(v);
    expect(all.filter((v) => SPEC_RE.test(v) !== narrower(v)).length).toBeGreaterThan(50);
  });

  it('rejects digits that are not ASCII', () => {
    // `\d` is ASCII-only in JS and this scan matches that on purpose: a
    // full-width or Arabic-Indic digit is not a number here.
    expect(isWhollyNumeric('１')).toBe(false);
    expect(isWhollyNumeric('١')).toBe(false);
  });
});

describe('deciding it is linear, not backtracking', () => {
  /**
   * The property is LINEARITY, so measure linearity: quadruple the input and
   * the time should roughly quadruple, not go up sixteenfold.
   *
   * This never runs the regex it replaced. Comparing against it proved only
   * "faster than that regex", which drags the regex's pathological cost and the
   * runner's speed into the assertion: it needed an absolute `regexMs > 50`
   * floor to stay meaningful, and that floor had under 4x of margin, so a
   * machine a few times faster than this one would have gone red with a message
   * that made no sense.
   *
   * Be clear about the division of labour, because it is not what it looks
   * like. A quadratic regression is caught by the two ABSOLUTE bounds, which
   * fire long before any ratio is computed -- they are the fast, blunt half.
   * The growth ratio is the half that states the actual claim (the cost is
   * linear in the length) and the half no runner speed can move, but on a
   * quadratic implementation it is never reached.
   *
   * The input sizes are bounded on purpose. A quadratic implementation at
   * n=200_000 needs about half an hour for ONE call, so a ratio measured there
   * would HANG rather than fail, and a hang burns the job instead of reporting.
   * At n=20_000 one such call is ~0.2s, which is why the guard below probes a
   * single call before it batches anything.
   */
  const SMALL = 20_000;
  const LARGE = 80_000; // 4x SMALL: linear predicts ~4x, quadratic ~16x.
  const TRIALS = 2; // Best of two batches, so one GC pause cannot inflate a reading.
  /** Ratio samples to take, keeping the smallest. Combined with TRIALS above,
   *  each side of the ratio draws its minimum from 2 x 3 = 6 independent batch
   *  timings — `min` over a partition is `min` over the union, exactly. */
  const RATIO_SAMPLES = 3;

  /** A batch has to be clearly above clock noise to divide by.
   *
   *  Raised from 2 to 5. A longer batch dilutes a fixed scheduler preemption:
   *  simulated over 15k runs with one-sided noise, false failures on a HEALTHY
   *  implementation drop from 0.38% to 0.04% at moderate contention and from
   *  4.93% to 3.70% at heavy contention, while the false-pass rate against a
   *  genuinely regressed implementation stays ~0%.
   *
   *  This file has the strongest claim on that change: it is the one that
   *  actually flaked, at 9.30 against a bound of 8 — close enough to the bound
   *  that noise around a 2ms floor is a plausible contributor. Measured cost
   *  here is about +130-150ms.
   *
   *  It composes with RATIO_SAMPLES rather than replacing it. Raising the
   *  floor while dropping back to a single ratio sample measures WORSE than
   *  either alone. */
  const MEASURABLE_MS = 5;

  const hostile = (n: number): string => `-${'1'.repeat(n)}x`;

  const once = (n: number): number => {
    const v = hostile(n);
    const t0 = performance.now();
    isWhollyNumeric(v);
    return performance.now() - t0;
  };

  /** Fastest of `TRIALS` batches of `reps` calls, in ms. */
  const batch = (n: number, reps: number): number => {
    const v = hostile(n);
    let best = Infinity;
    for (let trial = 0; trial < TRIALS; trial++) {
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) isWhollyNumeric(v);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  it('rejects the hostile input, so the timings measure a real decision', () => {
    // If this returned early the numbers below would be timing nothing.
    expect(isWhollyNumeric(hostile(SMALL))).toBe(false);
  });

  it('decides a 20k-character near-number quickly', () => {
    // The fast, blunt check. 0.32-0.39ms measured here; CI has come in around
    // 30x slower on this workload, so ~10ms against a 100ms bound. The regex
    // this replaced took ~180ms at this length.
    expect(once(SMALL)).toBeLessThan(100);
  });

  it('quadrupling the input roughly quadruples the time', { timeout: 30_000 }, () => {
    // Guard before batching. A cold call at the larger size is 0.5-0.9ms here
    // and ~25ms on a runner 30x slower, against a 200ms bound. Without it the
    // batches below run 400 calls: a quadratic implementation would take about
    // twenty minutes and a merely slow one several seconds, and a test that
    // grinds is worse than one that fails, because it burns the job instead of
    // reporting.
    expect(once(LARGE)).toBeLessThan(200);

    // CALIBRATE the batch size rather than fixing it. A fixed count is a
    // hardware-dependent assertion in the fast direction: a quick enough runner
    // cannot produce a measurable baseline, and the test then fails while the
    // implementation is perfectly correct. Doubling until the measurement is
    // comfortably above clock noise makes a faster machine do more work instead
    // of going red, and a slower one stop at the first batch.
    let reps = 50;
    let small = batch(SMALL, reps);
    while (small < MEASURABLE_MS && reps < 200_000) {
      reps *= 2;
      small = batch(SMALL, reps);
    }
    // Not a speed bound: this asserts CALIBRATION succeeded. Failing here means
    // 200k calls still take under 2ms, which is its own thing worth knowing.
    expect(small).toBeGreaterThanOrEqual(MEASURABLE_MS);

    // Minimise each SIDE independently, then divide once. CI produced a lone
    // 9.30 against this bound on 2026-08-24 while `main` was green, and one
    // sample should not decide the result — but the composition matters, and
    // the obvious version of this fix (which #3159 shipped) is wrong:
    //
    //   min(Aᵢ/Bᵢ) picks the sample where the numerator happened to be clean
    //   AND the denominator happened to be inflated. Those two flukes are
    //   selected for independently, so the estimator is biased LOW: it hunts
    //   for the most flattering pairing and hands a real regression a route
    //   under the bound.
    //
    //   min(Aᵢ)/min(Bᵢ) takes the cleanest measurement of each side and
    //   divides those. Noise here is one-sided — a preemption only ever adds
    //   time — which is exactly why `batch()` already does `Math.min` over
    //   TRIALS internally. This is that same composition one level up.
    //
    // This is not a statistical preference, it is an inequality. For any
    // positive samples, min(Lᵢ)/min(Sᵢ) ≥ min(Lᵢ/Sᵢ), ALWAYS: take i* = the
    // index minimising L, then min(Lᵢ/Sᵢ) ≤ L_i*/S_i* ≤ L_i*/min(S), and the
    // right-hand side is exactly min(L)/min(S) because L_i* IS min(L). So the
    // form below can never report a smaller growth than the one it replaces,
    // and therefore can never be the one that slips a regression under the
    // bound. Nothing about the noise distribution is assumed.
    //
    // It reduces the low bias rather than removing it: min(L) and min(S) are
    // each still inflated by whatever noise survives TRIALS, and the ratio is
    // only unbiased if that inflation is proportionally equal on both sides.
    // Worth knowing before tuning MEASURABLE_MS, TRIALS or RATIO_SAMPLES.
    //
    // The bound itself is unchanged. Raising it to absorb the outlier would
    // have widened the very gap the test exists to detect.
    let bestLarge = Infinity;
    let bestSmall = Infinity;
    for (let sample = 0; sample < RATIO_SAMPLES; sample++) {
      bestLarge = Math.min(bestLarge, batch(LARGE, reps));
      bestSmall = Math.min(bestSmall, batch(SMALL, reps));
    }
    const growth = bestLarge / bestSmall;
    // Measured over twelve runs at this configuration: the linear scan grows
    // 3.4x to 4.6x, the quadratic regex 15.6x to 17.0x. 8 sits between them.
    expect(growth).toBeLessThan(8);
  });

  // The explicit timeout is a backstop, not a crutch: this test does real work
  // whose wall time is set by the runner, and CI has twice come in far slower
  // than this machine. The assertions above are what bound the behaviour.
});
