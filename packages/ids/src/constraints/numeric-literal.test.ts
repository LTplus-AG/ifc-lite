/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The language the IDS numeric comparators accept, and the bound on what
 * deciding it costs.
 *
 * Both halves matter and they pull in opposite directions. `compareNumeric`
 * runs the check on `actualStr` — an IFC property value out of an uploaded
 * model — once per entity per constraint, so the check has to be cheap on a
 * FAILING input as well as a passing one. The regex that used to decide this
 * (`SPEC_RE` below) was quadratic on a failing match, which is #3113. Making it
 * linear is only half a fix: the accepted language has to come out unchanged,
 * because IDS cast-and-compare semantics ride on exactly which strings are
 * "strictly numeric" (`parseFloat('2022-01-01')` is 2022, and that must stay
 * opaque).
 */
import { describe, it, expect } from 'vitest';
import { compareNumeric, isStrictNumericLiteral } from './comparators.js';
import { literalCastsUnder } from './xsd-cast.js';
import { runCoherenceAudit } from '../audit/coherence/index.js';
import type { IDSDocument } from '../types.js';

/**
 * The spec: the regex `isStrictNumericLiteral` used to be, kept here so the
 * accepted language is stated in one line and any deliberate change to it has
 * to be made here too. It is not used in production because it backtracks —
 * see the timing block below.
 *
 * The oracle is deliberately this regex rather than a hand-listed table: a
 * table is written by whoever changed the implementation and shares their
 * blind spot, whereas the regex is a separate mechanism deciding the same
 * language, run over a generated corpus instead of a list anyone chose.
 */
const SPEC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Every string up to 4 characters over the alphabet the language is built
 *  from, plus the characters most likely to be wrongly accepted. */
function corpus(): string[] {
  const alpha = ['', '+', '-', '.', '0', '1', '9', 'e', 'E', ',', '_', ' ', '\t', '\n', 'x', '１', '١'];
  const out = new Set<string>();
  for (const a of alpha) for (const b of alpha) for (const c of alpha) for (const d of alpha) {
    out.add(a + b + c + d);
  }
  return [...out];
}

describe('isStrictNumericLiteral accepts exactly the language it always did', () => {
  const all = corpus();

  it('the corpus is actually populated (an empty sweep proves nothing)', () => {
    expect(all.length).toBeGreaterThan(50_000);
  });

  it('agrees with the spec regex on every string in it', () => {
    const disagree = all
      .filter((v) => SPEC_RE.test(v) !== isStrictNumericLiteral(v))
      .map((v) => JSON.stringify(v));
    expect(disagree).toEqual([]);
  });

  it('the sweep can fail: a deliberately narrower language is caught', () => {
    // Without this, an empty corpus or an always-agreeing oracle would also
    // report zero disagreements and the sweep above would pin nothing.
    const narrower = (v: string) => /^[+-]?\d+$/.test(v);
    expect(all.filter((v) => SPEC_RE.test(v) !== narrower(v)).length).toBeGreaterThan(50);
  });

  // The verdicts below were RECORDED by running the pre-fix regex over these
  // inputs, not written from a reading of the pattern. They are the edges the
  // sweep also covers, spelled out because each one is a distinct way an
  // "equivalent" rewrite goes wrong: a bare `.5`, a trailing `.`, an exponent
  // with no digits, a sign with nothing after it.
  const RECORDED: ReadonlyArray<readonly [string, boolean]> = [
    ['.5', true],
    ['5.', true],
    ['+.5', true],
    ['-5.', true],
    ['+1', true],
    ['1e+5', true],
    ['1E-5', true],
    ['5.e3', true],
    ['.5e3', true],
    ['-0', true],
    ['1e', false],
    ['+', false],
    ['-', false],
    ['.', false],
    ['', false],
    [' 1', false],
    ['1 ', false],
    ['  1  ', false],
    ['1 2', false],
    ['Infinity', false],
    ['NaN', false],
    ['0x10', false],
    ['1_000', false],
    ['1e5.5', false],
    ['e5', false],
    ['1.2.3', false],
  ];

  it.each(RECORDED)('%j -> %s, as the regex it replaced decided it', (value, accepted) => {
    expect(isStrictNumericLiteral(value)).toBe(accepted);
    // The recorded verdict really is the old regex's, not a transcription slip.
    expect(SPEC_RE.test(value)).toBe(accepted);
  });

  it('keeps date-shaped strings opaque, which is what the strictness is for', () => {
    // parseFloat('2022-01-01') is 2022; the comparator must refuse to decide.
    expect(isStrictNumericLiteral('2022-01-01')).toBe(false);
    expect(compareNumeric('2022', '2022-01-01')).toBeUndefined();
  });

  it('still compares real numbers, so the guard has not swallowed the feature', () => {
    expect(compareNumeric('1.5', '1.5')).toBe(true);
    expect(compareNumeric('1.5', '1.6')).toBe(false);
    expect(compareNumeric('.5', '0.5')).toBe(true);
    expect(compareNumeric('1e3', '1000')).toBe(true);
  });
});

describe('deciding it is linear, not backtracking (#3113)', () => {
  /**
   * The property is LINEARITY, so linearity is what gets measured: quadruple
   * the input and the time should roughly quadruple, not go up sixteenfold.
   *
   * Division of labour, because it is not what it looks like. A quadratic
   * regression is caught by the two ABSOLUTE bounds, which fire long before
   * any ratio is computed — they are the blunt, fast half. The growth ratio is
   * the half that states the actual claim (cost is linear in the length) and
   * the half no runner speed can move; on a quadratic implementation it is
   * never reached, because the absolute bound has already failed.
   *
   * Nothing here times the old regex. Comparing against it would drag its
   * pathological cost and the runner's speed into the assertion.
   *
   * The sizes are bounded on purpose. Quadratic cost at n=200_000 is minutes
   * for ONE call, so a ratio measured there would HANG rather than fail, and a
   * hang burns the job instead of reporting. Hence the single-call probe before
   * anything is batched.
   */
  const SMALL = 20_000;
  const LARGE = 80_000; // 4x SMALL: linear predicts ~4x, quadratic ~16x.
  const TRIALS = 2; // Best of two batches, so one GC pause cannot inflate a reading.
  /** A batch has to be clearly above clock noise to divide by.
   *
   *  Raised from 2 to 5 on review. A longer batch dilutes a fixed scheduler
   *  preemption: simulated over 15k runs with one-sided noise, false failures
   *  on a HEALTHY implementation drop from 0.38% to 0.04% at moderate
   *  contention, and from 4.93% to 3.70% at heavy contention. The false-pass
   *  rate against a genuinely regressed implementation stayed ~0% throughout,
   *  so this buys stability without costing detection.
   *
   *  It is not a substitute for RATIO_SAMPLES below, and the review's original
   *  suggestion — raise the floor and drop back to one ratio sample — measured
   *  WORSE than what was already here. The two compose; either alone is
   *  weaker. Cost is about +195ms on this one `it` block. */
  const MEASURABLE_MS = 5;

  /** Ratio samples to take, keeping the smallest. Combined with TRIALS above,
   *  each side of the ratio draws its minimum from 2 x 3 = 6 independent batch
   *  timings — `min` over a partition is `min` over the union, exactly. The
   *  review suggested TRIALS = 3 instead, which would give 3 per side, half of
   *  this. */
  const RATIO_SAMPLES = 3;

  /** A long digit run plus one character that cannot be part of a number.
   *  The trailing non-digit is the whole point: an all-digit string of any
   *  length matches immediately, which is why plausible fixtures miss this. */
  const hostile = (n: number): string => `-${'9'.repeat(n)}X`;

  const once = (n: number): number => {
    const v = hostile(n);
    const t0 = performance.now();
    isStrictNumericLiteral(v);
    return performance.now() - t0;
  };

  /** Fastest of `TRIALS` batches of `reps` calls, in ms. */
  const batch = (n: number, reps: number): number => {
    const v = hostile(n);
    let best = Infinity;
    for (let trial = 0; trial < TRIALS; trial++) {
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) isStrictNumericLiteral(v);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  it('rejects the hostile input, so the timings measure a real decision', () => {
    // If this returned early the numbers below would be timing nothing.
    expect(isStrictNumericLiteral(hostile(SMALL))).toBe(false);
  });

  it('decides a 20k-character near-number quickly', () => {
    // The blunt check. ~0.03ms measured on the dev machine; the regex this
    // replaced took ~420ms at this length, so the 100ms bound has three
    // orders of magnitude of headroom for a slow runner and still fails
    // outright on the quadratic form.
    expect(once(SMALL)).toBeLessThan(100);
  });

  it('quadrupling the input roughly quadruples the time', { timeout: 30_000 }, () => {
    // Guard before batching. A cold call at the larger size is ~0.1ms here.
    // Without this the batches below run hundreds of calls, and a quadratic
    // implementation would grind for many minutes instead of reporting.
    expect(once(LARGE)).toBeLessThan(200);

    // CALIBRATE the batch size rather than fixing it. A fixed count is a
    // hardware-dependent assertion in the fast direction: a quick enough
    // runner cannot produce a measurable baseline and the test goes red while
    // the implementation is perfectly correct. Doubling until the measurement
    // clears clock noise makes a faster machine do more work instead of
    // failing, and a slower one stop at the first batch.
    let reps = 50;
    let small = batch(SMALL, reps);
    while (small < MEASURABLE_MS && reps < 200_000) {
      reps *= 2;
      small = batch(SMALL, reps);
    }
    // Not a speed bound: this asserts CALIBRATION succeeded. Failing here
    // means 200k calls still take under MEASURABLE_MS, which is its own thing
    // worth knowing. Named rather than restated so raising the floor cannot
    // leave a stale number here — it already did once.
    expect(small).toBeGreaterThanOrEqual(MEASURABLE_MS);

    // Minimise each SIDE independently, then divide once — not the minimum of
    // several ratios. The difference matters, and getting it backwards makes
    // the test worse than taking a single sample:
    //
    //   min(Aᵢ/Bᵢ) picks the sample where the numerator happened to be clean
    //   AND the denominator happened to be inflated. Those two flukes are
    //   selected for independently, so the result is biased LOW — it hunts for
    //   the most flattering pairing and hands a real regression a way under
    //   the bound.
    //
    //   min(Aᵢ)/min(Bᵢ) takes the cleanest measurement of each side, which is
    //   the best estimate of each, and divides those. Noise here is one-sided
    //   (a preemption only ever adds time), which is exactly why `batch()`
    //   already does `Math.min` over TRIALS internally. This is the same
    //   composition one level up.
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
    // The bound itself is unchanged. Raising it to absorb an outlier would
    // widen the very gap the test exists to detect.
    let bestLarge = Infinity;
    let bestSmall = Infinity;
    for (let sample = 0; sample < RATIO_SAMPLES; sample++) {
      bestLarge = Math.min(bestLarge, batch(LARGE, reps));
      bestSmall = Math.min(bestSmall, batch(SMALL, reps));
    }
    const growth = bestLarge / bestSmall;
    // The linear scan grows ~3.3x-4.5x across repeated runs on this machine;
    // the quadratic regex grew ~9x at these sizes and far more at larger ones.
    // 8 sits between them.
    expect(growth).toBeLessThan(8);
  });

  it('bounds the per-entity path too, not just the literal check', () => {
    // This is the reachable one: `compareNumeric` runs the check on the model
    // side (`actualStr`) once per entity, from constraints/index.ts.
    const v = hostile(SMALL);
    const t0 = performance.now();
    const result = compareNumeric('1000', v);
    const elapsed = performance.now() - t0;
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(100);
  });
});

/**
 * The same shape lived twice more inside this package, on IDS-file literals
 * rather than model values. Both are bounded here, and both acceptance sets
 * are pinned against the regex each one replaced, generated the same way.
 */
describe('the same shape elsewhere in @ifc-lite/ids', () => {
  const hostile = (n: number): string => `-${'9'.repeat(n)}X`;

  describe('xs:double strict cast (constraints/xsd-cast.ts)', () => {
    /** The `DOUBLE_RE` that `literalCastsUnder` used to test against. */
    const DOUBLE_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

    it('accepts exactly the language DOUBLE_RE did', () => {
      const disagree = corpus()
        .filter((v) => DOUBLE_RE.test(v) !== literalCastsUnder(v, 'xs:double'))
        .map((v) => JSON.stringify(v));
      expect(disagree).toEqual([]);
    });

    it('leaves the other XSD casts alone', () => {
      expect(literalCastsUnder('42', 'xs:integer')).toBe(true);
      expect(literalCastsUnder('42.0', 'xs:integer')).toBe(false);
      expect(literalCastsUnder('2022-01-01', 'xs:date')).toBe(true);
      expect(literalCastsUnder('true', 'xs:boolean')).toBe(true);
      expect(literalCastsUnder('anything', 'xs:string')).toBe(true);
    });

    it('decides a 20k-character near-number quickly', () => {
      // ~440ms with DOUBLE_RE at this length, measured before the change.
      const v = hostile(20_000);
      const t0 = performance.now();
      const cast = literalCastsUnder(v, 'xs:double');
      const elapsed = performance.now() - t0;
      expect(cast).toBe(false);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('xs:double/float/decimal lexical space (audit/coherence)', () => {
    /** The table entry these three bases used to share. */
    const XS_DOUBLE_RE = /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/;

    /** One specification whose enumeration carries `values` under `base`. */
    const docWith = (values: string[], base: string): IDSDocument => ({
      info: { title: 'T' },
      specifications: [
        {
          id: 's1',
          name: 'S',
          ifcVersions: ['IFC4'],
          applicability: {
            facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }],
          },
          requirements: [
            {
              id: 'r1',
              optionality: 'required',
              facet: {
                type: 'attribute',
                name: { type: 'simpleValue', value: 'Name' },
                value: { type: 'enumeration', values, base },
              },
            },
          ],
        },
      ],
    });

    /** Whether the audit accepted `value` as a lexical `base`. */
    const accepts = (value: string, base: string): boolean =>
      !runCoherenceAudit(docWith([value], base)).some(
        (i) => i.code === 'E_RESTRICTION_VALUE_MISMATCH'
      );

    it('the fixture reaches the check at all (a doc with no issue proves nothing)', () => {
      // If the harness never produced the code, every `accepts` below would
      // read `true` and the parity sweep would be vacuous.
      expect(accepts('not-a-number', 'xs:double')).toBe(false);
      expect(accepts('12.0', 'xs:double')).toBe(true);
    });

    // The corpus here is smaller than the sweep above because each case runs a
    // whole audit; it is still generated, not chosen.
    const sample = (() => {
      const alpha = ['', '+', '-', '.', '0', '9', 'e', 'E', ',', ' ', 'x'];
      const out = new Set<string>();
      for (const a of alpha) for (const b of alpha) for (const c of alpha) out.add(a + b + c);
      for (const w of ['NaN', '+INF', '-INF', 'INF', 'nan', '1.2e3', '1e+', '12,0']) out.add(w);
      out.delete(''); // the empty entry is a different check (E_RESTRICTION_EMPTY)
      return [...out];
    })();

    it.each(['xs:double', 'xs:float', 'xs:decimal'])(
      '%s accepts exactly the lexical space it did before',
      (base) => {
        const disagree = sample
          .filter((v) => {
            // The pre-existing "no digit at all" veto sits outside the regex;
            // model the whole decision, not just the pattern.
            const before = /[0-9]/.test(v) && XS_DOUBLE_RE.test(v);
            return before !== accepts(v, base);
          })
          .map((v) => JSON.stringify(v));
        expect(disagree).toEqual([]);
      }
    );

    it('audits a 20k-character near-number enumeration quickly', () => {
      // ~415ms in the regex alone at this length, measured before the change.
      const doc = docWith([hostile(20_000)], 'xs:double');
      const t0 = performance.now();
      const issues = runCoherenceAudit(doc);
      const elapsed = performance.now() - t0;
      expect(issues.some((i) => i.code === 'E_RESTRICTION_VALUE_MISMATCH')).toBe(true);
      expect(elapsed).toBeLessThan(100);
    });
  });
});
