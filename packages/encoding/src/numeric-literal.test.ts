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
  /** A batch has to be clearly above clock noise to divide by. */
  const MEASURABLE_MS = 2;

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

    const growth = batch(LARGE, reps) / small;
    // Measured over twelve runs at this configuration: the linear scan grows
    // 3.4x to 4.6x, the quadratic regex 15.6x to 17.0x. 8 sits between them.
    expect(growth).toBeLessThan(8);
  });

  // The explicit timeout is a backstop, not a crutch: this test does real work
  // whose wall time is set by the runner, and CI has twice come in far slower
  // than this machine. The assertions above are what bound the behaviour.
});
