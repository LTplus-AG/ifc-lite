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
import { firstBlownRung as ladderFirstBlownRung, SIZES } from '@ifc-lite/timing-ladder';
import { compareNumeric, isStrictNumericLiteral } from './comparators.js';
import { XSD_NUMERIC_SPECIALS, literalCastsUnder } from './xsd-cast.js';
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
 *
 * One constant for both sweeps below because there is one function beneath
 * them: `isStrictNumericLiteral` and the `xs:double` arm of `xsd-cast.ts` both
 * `return isWhollyNumeric(value)` from `@ifc-lite/encoding`. A second copy of
 * this regex to pin the cast would be a copy to keep in sync, not a second
 * opinion.
 */
const SPEC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Every string up to 4 characters over the alphabet the language is built
 *  from, plus the characters most likely to be wrongly accepted. That is
 *  69,905 distinct strings; the count is asserted below rather than trusted
 *  from this comment. */
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
    // Exact, so the size quoted in the docblock and in any write-up of this
    // sweep is a recorded figure and not an estimate. Changing the alphabet
    // is meant to red here, forcing the new count to be re-recorded.
    expect(all.length).toBe(69_905);
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

/** A long digit run plus one character that cannot be part of a number.
 *  The trailing non-digit is the whole point: an all-digit string of any
 *  length matches immediately, which is why plausible fixtures miss this. */
const hostile = (n: number): string => `-${'9'.repeat(n)}X`;

/**
 * The ladder every timing assertion in this file runs, module-scoped because
 * four separate call sites use it: the scan itself, the per-entity
 * `compareNumeric` path, and the two IDS-file literal paths at the bottom of
 * the file. One ladder means one budget and one retry policy, so a hardening
 * applied here cannot miss a caller.
 *
 * Budget, rungs and retry policy come from @ifc-lite/timing-ladder, shared with
 * the twin suite in @ifc-lite/encoding, which used to carry a line-for-line
 * copy of them (#3224). It refuses -- loudly -- any decision that ACCEPTS the
 * hostile fixture, so the early-ACCEPT path -- the one that would make a
 * reading meaningless -- cannot pass silently.
 */
const firstBlownRung = (decide: (v: string) => boolean): number | null =>
  ladderFirstBlownRung(decide, { hostile });

describe('deciding it is linear, not backtracking (#3113)', () => {
  /**
   * The property is "this decision does not blow up on a long hostile input".
   * What follows asserts that DIRECTLY, with an absolute budget per input size,
   * instead of measuring how the wall clock grows between two sizes.
   *
   * Why the growth ratio had to go. It measured the runner, not the scan. On
   * 2026-08-23 it failed on three unrelated PRs that touch none of this code
   * (13.33, 8.42, 8.37 against a bound of 8) while `main` stayed green, and
   * 13.33 is inside the band the old comment called quadratic. Reproduced
   * deliberately: this exact scan, unmodified, run 20 times under 160 busy
   * processes on 12 cores, produced ratios from 3.68 to 18.81 with 12 of 20
   * over the bound. Unloaded on the same machine the 20 readings spanned
   * 3.90-4.24. The implementation never changed; only the load did. A ratio of
   * two timings taken at different moments cannot cancel contention, because
   * contention arrives in bursts rather than as a constant factor -- which is
   * also why minimising over batches (#3159, #3165) narrowed the distribution
   * without fixing it.
   *
   * Why the budget survives what the ratio could not: it is measured on the CPU
   * clock, in @ifc-lite/timing-ladder. Headroom on the WALL clock was never
   * what protected this test, and the version of this paragraph that said
   * ATTEMPTS protected it was wrong (#3224). Three attempts are taken
   * back-to-back and span ~11ms of real work at the largest rung, so a
   * contention burst longer than that covers all three. Measured: this exact
   * linear scan, unmodified, running the real ladder 100 times under 900 busy
   * processes on 12 cores, blew the 2.56M rung 3 times -- readings
   * `812.5, 968.1, 549.9` and `1226.1, 1168.2, 1137.6` against a 500ms budget.
   * `2560000` is the value CI reported against an unrelated parser PR. On the
   * CPU clock the same 200 readings under the same load ran p50 5.67ms, p99
   * 8.88ms, max 9.93ms, against 7.13ms idle. ATTEMPTS is kept as a second line
   * of defence and costs nothing on the healthy path, because `Math.min` can
   * only fall and a reading already inside the budget is final.
   *
   * The price is real and it is not a saving. Each negative control climbs to
   * the rung it blows and then spends ATTEMPTS readings there, so the controls
   * are the whole cost: 5334ms, 3999ms and 2068ms in one verbose run of the ids
   * copy, against 8ms for the healthy ladder sitting next to them. Measured on
   * one machine the file costs 8.7-12.9s in @ifc-lite/encoding and 8.1-12.1s
   * in @ifc-lite/ids, against the ~500ms per assertion of the batching
   * it replaces. Net CI cost went UP an order of magnitude. That is the price
   * of a timing assertion that holds; the cheaper one reddened three unrelated
   * PRs.
   *
   * The ladder itself -- budget, rungs, retry policy and the CPU-clock reading
   * -- lives in @ifc-lite/timing-ladder and is shared with the twin suite in
   * @ifc-lite/encoding, which used to carry a line-for-line copy of it (#3224).
   * Its own tests pin that it still blows a rung on a quadratic decision, still
   * refuses a decision that accepts the fixture, and still reads the CPU clock.
   *
   * The bound the old test used is not carried over and not raised; the
   * quantity it bounded is simply not measured any more.
   *
   * Nothing is given up against the ratio on the axis that was thought to cost
   * it. A linear-but-slower implementation passed the OLD test too: a ratio of
   * two timings cancels constant factors by construction, so it never bounded
   * absolute speed at all. The absolute budget does bound it, if loosely --
   * anything ~135x more WORK than the current scan at 2.56M now reds, where the
   * ratio would not have noticed. "Work" and not "wall time" since #3224: the
   * budget is spent against the CPU clock. What both forms exist to catch first is
   * catastrophic backtracking, which is orders of magnitude rather than
   * factors, and the negative controls below pin exactly that.
   *
   * The shape that a ratio catches and an absolute bound does not is a
   * SUPERLINEAR regression with a small enough constant to stay under the
   * budget (#3226 review). That is why the ladder runs to 2.56M rather than
   * stopping at 640k: measured, one extra full scan per 4000 characters costs
   * 143ms at 640k -- inside a 500ms budget, so a six-rung ladder would have
   * missed it -- and 572ms at 1.28M, where it blows. The third control below
   * is exactly that implementation, so the claim is pinned rather than
   * asserted. Two more rungs cost the healthy scan ~2ms (3.70ms at 2.56M
   * against the 500ms budget, ~135x of headroom), because the extra rungs are
   * only expensive for an implementation that is already superlinear. That
   * headroom is now real rather than nominal: on the CPU clock the same rung
   * stayed at 9.93ms worst-of-200 under 900 busy processes.
   *
   * What remains knowingly out of scope after that: a superlinear regression
   * whose constant is smaller still, staying inside the budget even at 2.56M.
   * Nothing here would catch it. That is accepted rather than overlooked --
   * the function is ~25 lines of straight-line scanning with no regex left in
   * it, so the shape requires someone adding a nested loop, which is visible in
   * review. #3113 was dangerous precisely because a regex LOOKED linear.
   */

  it('rejects the hostile input, so the ladder times a real decision', () => {
    expect(isStrictNumericLiteral(hostile(20_000))).toBe(false);
    // ...and accepts the same digits without the trailing character, so the
    // fixture is hostile by one character rather than malformed some other way.
    expect(isStrictNumericLiteral(`-${'9'.repeat(20_000)}`)).toBe(true);
  });

  it('decides every size up to 2.56M characters inside the budget', { timeout: 60_000 }, () => {
    expect(firstBlownRung(isStrictNumericLiteral)).toBeNull();
  });

  it('bounds the per-entity path too, not just the literal check', { timeout: 60_000 }, () => {
    // This is the reachable one: `compareNumeric` runs the check on the model
    // side (`actualStr`) once per entity, from constraints/index.ts. It gets
    // the same ladder rather than a lone 20k probe, so the path an uploaded
    // model actually reaches carries the same margin as the check beneath it.
    expect(firstBlownRung((v) => compareNumeric('1000', v) !== undefined)).toBeNull();
  });

  /**
   * The controls. Without these the tests above would pass on an empty ladder,
   * a budget nothing can exceed, or a `decide` that returns early -- and a
   * timing test that cannot go red is worse than no timing test, because it
   * reads as protection.
   *
   * All three run the SAME ladder as the assertions above, so what is
   * demonstrated is those assertions failing, not a separate one built to fail.
   */
  it('the ladder can fail: the quadratic regex it replaced blows a rung', { timeout: 60_000 }, () => {
    // SPEC_RE is not a strawman -- it is the implementation that shipped, and
    // the one #3113 was filed against. `\d+\.?\d*` retries at every split of
    // the digit run before the engine gives up.
    expect(firstBlownRung((v) => SPEC_RE.test(v))).not.toBeNull();
  });

  it('the ladder can fail: a hand-written backtracking scan blows a rung', { timeout: 60_000 }, () => {
    // Pins the property rather than the mechanism. The control above could be
    // dismissed as "regexes are slow"; this one is a plain loop that decides
    // the IDENTICAL language (asserted below, not assumed) and differs from the
    // real scan only in that it re-scans the tail at each split point.
    const alsoBacktracks = corpus().every(
      (v) => isStrictNumericLiteralBacktracking(v) === isStrictNumericLiteral(v)
    );
    expect(alsoBacktracks).toBe(true);
    expect(firstBlownRung(isStrictNumericLiteralBacktracking)).not.toBeNull();
  });

  it('the ladder can fail: a superlinear scan with a small constant blows a rung', { timeout: 60_000 }, () => {
    // The shape the removed ratio used to catch, and the reason the ladder
    // runs past 640k (#3226 review). It delegates the DECISION to the real
    // scan, so the language is identical by construction and the only
    // difference is wasted work -- which is what makes it a clean probe of
    // sensitivity rather than of correctness.
    // The precondition this control rests on, asserted BEFORE the ladder runs
    // so a trimmed ladder fails with THIS reason instead of as a null `blown`
    // below. What stood here -- `expect(blown).toBeLessThanOrEqual(2_560_000)`
    // -- could not fail (#3285): `firstBlownRung` returns a member of SIZES or
    // null, 2_560_000 IS the largest member, and null is already caught by the
    // line above it. The property that assertion was reaching for is about the
    // LADDER, not about `blown`: this control still decides 640k inside the
    // budget, so a ladder that stops there would report `null` and prove
    // nothing about sensitivity.
    const DECIDED_INSIDE_BUDGET = 640_000;
    expect(SIZES[SIZES.length - 1]).toBeGreaterThan(DECIDED_INSIDE_BUDGET);
    const blown = firstBlownRung(isStrictNumericLiteralSmallConstantSuperlinear);
    expect(blown).not.toBeNull();
  });
});

/**
 * A deliberately backtracking implementation of the same matcher, used only as
 * the negative control above. It mirrors what a regex engine does for
 * `\d+\.?\d*`: pick a split point for the leading `\d+`, match `\.?` then `\d*`
 * from there, and on failure back the split up one digit and try the tail
 * again. The `\d*` re-scan is what costs O(n^2) on a failing input.
 *
 * A first draft of this omitted that re-scan and was accidentally LINEAR -- it
 * cleared the whole ladder in 9ms and would have made the control vacuous. The
 * timing is therefore load-bearing and is asserted, not described.
 */
function isStrictNumericLiteralBacktracking(v: string): boolean {
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';

  const matchExponentAndEnd = (i: number, n: number): boolean => {
    if (i < n && (v[i] === 'e' || v[i] === 'E')) {
      let j = i + 1;
      if (j < n && (v[j] === '+' || v[j] === '-')) j++;
      let d = 0;
      while (j < n && isDigit(v[j])) { j++; d++; }
      if (d > 0 && j === n) return true;
      // The exponent failed to match, so the optional group matches empty.
    }
    return i === n;
  };

  const n = v.length;
  let start = 0;
  if (start < n && (v[start] === '+' || v[start] === '-')) start++;

  let run = start;
  while (run < n && isDigit(v[run])) run++;

  // `\d+\.?\d*`, greedy split first, then backing off one digit at a time.
  for (let take = run - start; take >= 1; take--) {
    let i = start + take;
    if (i < n && v[i] === '.') i++;
    while (i < n && isDigit(v[i])) i++; // the re-scan: O(n) per split point
    if (matchExponentAndEnd(i, n)) return true;
  }

  // The `\.\d+` alternative.
  let i = start;
  if (i < n && v[i] === '.') {
    i++;
    let d = 0;
    while (i < n && isDigit(v[i])) { i++; d++; }
    if (d > 0 && matchExponentAndEnd(i, n)) return true;
  }
  return false;
}

/**
 * The same shape lived twice more inside this package, on IDS-file literals
 * rather than model values. Both are bounded here, and both acceptance sets
 * are pinned against the regex each one replaced, generated the same way.
 */
describe('the same shape elsewhere in @ifc-lite/ids', () => {
  describe('xs:double strict cast (constraints/xsd-cast.ts)', () => {
    it('agrees with the spec regex across the FINITE language this corpus covers', () => {
      // Scoped to FINITE deliberately. Since #3336 the cast also accepts `NaN`,
      // `+INF` and `-INF`, which SPEC_RE does not, so the two no longer decide
      // one language outright. This sweep stays true because corpus() is built
      // from an alphabet with no letters, so it cannot reach those three; the
      // title says so rather than letting a structural gap read as equality.
      // The specials themselves are pinned in xsd-cast-specials.test.ts.
      const disagree = corpus()
        .filter((v) => SPEC_RE.test(v) !== literalCastsUnder(v, 'xs:double'))
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

    it('decides every size up to 2.56M characters inside the budget', { timeout: 60_000 }, () => {
      // ~440ms with the spec regex at 20k, measured before the change. This used to
      // be a single 20k reading against a 100ms bound, which is the construct
      // the ladder above exists to replace: one reading has no retry, so a
      // single descheduling reds it. Measured under 187-process load, 24 of
      // 12,000 single 20k WALL-CLOCK readings here exceeded 100ms (max 265ms)
      // against a median of 0.058ms -- ~0.2% flake per assertion. The ladder
      // spends its budget against the CPU clock instead, which does not tick
      // while the operating system has chosen not to run us (#3224).
      expect(firstBlownRung((v) => literalCastsUnder(v, 'xs:double'))).toBeNull();
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

    /** The decision both sites now make, modelled independently of either.
     *
     *  The digit must be in the MANTISSA: testing the whole lexeme accepted
     *  `e5` on the strength of the exponent's digit, which is how the audit and
     *  the cast came to disagree while both looked right (#3336). The specials
     *  carry no digit at all and are valid, so they are exempt rather than
     *  swept up by the same veto. */
    const decidesValid = (v: string): boolean => {
      if (!XS_DOUBLE_RE.test(v)) return false;
      if (XSD_NUMERIC_SPECIALS.has(v)) return true;
      return /[0-9]/.test(v.split(/[eE]/)[0]);
    };

    it.each(['xs:double', 'xs:float', 'xs:decimal'])(
      '%s accepts the lexical space, specials included, digitless forms not',
      (base) => {
        // This used to pin "exactly the lexical space it did before", with
        // `before = /[0-9]/.test(v) && XS_DOUBLE_RE.test(v)`. That decision was
        // wrong in two directions at once and #3336 changed it, so the oracle
        // had to change too -- a characterisation test cannot outlive the
        // behaviour it characterises without quietly asserting the old bug.
        const disagree = sample
          .filter((v) => decidesValid(v) !== accepts(v, base))
          .map((v) => JSON.stringify(v));
        expect(disagree).toEqual([]);
      }
    );

    it('the audit and the cast decide xs:double identically', () => {
      // The whole point of #3336: one literal, one answer. The audit judges an
      // enumeration value and the cast gates a simpleValue -- different
      // questions about the same language, which used to differ on the three
      // specials AND on the exponent-only family.
      const disagree = sample
        .filter((v) => accepts(v, 'xs:double') !== literalCastsUnder(v, 'xs:double'))
        .map((v) => `${JSON.stringify(v)} audit=${accepts(v, 'xs:double')} cast=${literalCastsUnder(v, 'xs:double')}`);
      expect(disagree).toEqual([]);
    });

    it.each(['NaN', '+INF', '-INF'])('accepts %j, which upstream accepts', (v) => {
      expect(accepts(v, 'xs:double')).toBe(true);
      expect(literalCastsUnder(v, 'xs:double')).toBe(true);
    });

    it.each(['e5', 'E5', '+e5', '.e5', 'INF', 'Infinity'])(
      'rejects %j in both places',
      (v) => {
        // `e5` is the one the audit used to accept on its own: the veto tested
        // the whole lexeme, and the exponent supplied the digit.
        expect(accepts(v, 'xs:double')).toBe(false);
        expect(literalCastsUnder(v, 'xs:double')).toBe(false);
      }
    );

    it('audits every size up to 2.56M characters inside the budget', { timeout: 60_000 }, () => {
      // ~415ms in the regex alone at 20k, measured before the change. Same
      // migration as the cast above, and for the same reason: the lone 20k
      // reading against a 100ms bound was flaky under load by construction.
      // `accepts` returning false IS the E_RESTRICTION_VALUE_MISMATCH the old
      // assertion checked for, so the verdict is still pinned -- the shared
      // ladder throws if any rung ever decides the hostile input is a number.
      expect(firstBlownRung((v) => accepts(v, 'xs:double'))).toBeNull();
    });
  });
});

/**
 * The same decision, plus one full extra pass over the input per 4000
 * characters. Superlinear, but with a constant small enough that the cost stays
 * inside the per-decision budget for a long way -- the shape an absolute bound
 * alone does not catch, used as the third negative control above.
 *
 * It delegates to the real implementation for the verdict, so it decides the
 * identical language by construction; there is no corpus assertion here because
 * there is nothing that could diverge.
 */
function isStrictNumericLiteralSmallConstantSuperlinear(v: string): boolean {
  let sink = 0;
  for (let outer = 0; outer < Math.floor(v.length / 4000) + 1; outer++) {
    for (let i = 0; i < v.length; i++) {
      if (v[i] >= '0' && v[i] <= '9') sink += 1;
    }
  }
  // Keeps the loops above observable: without a use of `sink` an optimiser is
  // free to delete them, and the control would silently become the real scan.
  if (sink < 0) return false;
  return isStrictNumericLiteral(v);
}
