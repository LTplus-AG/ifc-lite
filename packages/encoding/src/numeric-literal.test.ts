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
   * Why the budget survives what the ratio could not: MARGIN. The old ratio put
   * a healthy reading at ~4 against a bound of 8, so a 2x hiccup was a failure.
   * The largest rung here decides 640k characters in ~1.2ms against a 500ms
   * budget -- over 400x of headroom, which no scheduler noise reaches. The same
   * 160-process load that broke the ratio 12 times in 20 leaves this green 20
   * times in 20, and the whole ladder costs ~5ms instead of the ~500ms of
   * batching it replaces.
   *
   * The bound the old test used is not carried over and not raised; the
   * quantity it bounded is simply not measured any more.
   *
   * What this gives up, stated plainly: an implementation that is linear but
   * several times slower passes. That is the right trade. The regression this
   * exists to catch is catastrophic backtracking, which is orders of magnitude,
   * not factors -- and the negative controls below pin exactly that.
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
   * only expensive for an implementation that is already superlinear.
   *
   * What remains knowingly out of scope after that: a superlinear regression
   * whose constant is smaller still, staying inside the budget even at 2.56M.
   * Nothing here would catch it. That is accepted rather than overlooked --
   * the function is ~25 lines of straight-line scanning with no regex left in
   * it, so the shape requires someone adding a nested loop, which is visible in
   * review. #3113 was dangerous precisely because a regex LOOKED linear.
   */

  /** Per-decision budget. Every size below must be decided inside it. */
  const BUDGET_MS = 500;

  /**
   * Ascending, doubling. Ascending is what makes a quadratic implementation
   * REPORT instead of HANG: cost rises 4x per rung, so the first rung it blows
   * costs at most ~4x the budget, and the ladder stops there rather than
   * carrying on to 640k where the same implementation would grind for minutes.
   *
   * It self-adapts to the runner in both directions. A slower machine blows a
   * quadratic implementation at a lower rung; a faster one at a higher rung.
   * Either way some rung fails, so the controls below need no hardware-tuned
   * number -- the failure that the old `regexMs > 50` floor could not survive.
   */
  const SIZES = [
    20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000,
  ] as const;

  /**
   * Retries only ever taken on the way to FAILING. `Math.min` can only fall, so
   * a reading already inside the budget is final and no repeat is made -- the
   * healthy path is one call per rung. A rung is only declared blown after
   * ATTEMPTS consecutive readings over the budget, which a single descheduling
   * cannot fake. This does not soften detection: the minimum of several
   * quadratic timings is still quadratic.
   */
  const ATTEMPTS = 3;

  /** A long digit run plus one character that cannot be part of a number. The
   *  trailing non-digit is the whole point: an all-digit string of any length
   *  matches immediately, which is why plausible fixtures miss this. */
  const hostile = (n: number): string => `-${'1'.repeat(n)}x`;

  type Decide = (v: string) => boolean;

  /** Fastest of up to ATTEMPTS decisions, stopping as soon as one is in budget. */
  const fastestMs = (decide: Decide, n: number): number => {
    const v = hostile(n);
    let best = Infinity;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const t0 = performance.now();
      const verdict = decide(v);
      best = Math.min(best, performance.now() - t0);
      // A decision that says "number" would mean the timing measured an early
      // return rather than a full scan, so the reading would prove nothing.
      expect(verdict).toBe(false);
      if (best < BUDGET_MS) break;
    }
    return best;
  };

  /** The first size at which `decide` blew the budget, or null if it cleared them all. */
  const firstBlownRung = (decide: Decide): number | null => {
    for (const n of SIZES) {
      if (fastestMs(decide, n) >= BUDGET_MS) return n;
    }
    return null;
  };

  it('rejects the hostile input, so the ladder times a real decision', () => {
    expect(isWhollyNumeric(hostile(20_000))).toBe(false);
    // ...and accepts the same digits without the trailing character, so the
    // fixture is hostile by one character rather than malformed some other way.
    expect(isWhollyNumeric(`-${'1'.repeat(20_000)}`)).toBe(true);
  });

  it('decides every size up to 2.56M characters inside the budget', { timeout: 60_000 }, () => {
    expect(firstBlownRung(isWhollyNumeric)).toBeNull();
  });

  /**
   * The controls. Without these the test above would pass on an empty ladder,
   * a budget nothing can exceed, or a `decide` that returns early -- and a
   * timing test that cannot go red is worse than no timing test, because it
   * reads as protection.
   *
   * All three run the SAME ladder as the assertion above, so what is
   * demonstrated is that assertion failing, not a separate one built to fail.
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
      (v) => isWhollyNumericBacktracking(v) === isWhollyNumeric(v)
    );
    expect(alsoBacktracks).toBe(true);
    expect(firstBlownRung(isWhollyNumericBacktracking)).not.toBeNull();
  });

  it('the ladder can fail: a superlinear scan with a small constant blows a rung', { timeout: 60_000 }, () => {
    // The shape the removed ratio used to catch, and the reason the ladder
    // runs past 640k (#3226 review). It delegates the DECISION to the real
    // scan, so the language is identical by construction and the only
    // difference is wasted work -- which is what makes it a clean probe of
    // sensitivity rather than of correctness.
    const blown = firstBlownRung(isWhollyNumericSmallConstantSuperlinear);
    expect(blown).not.toBeNull();
    // Named, not just non-null: if a future edit trims the ladder back to
    // 640k this fails with the reason rather than going quietly vacuous.
    expect(blown).toBeLessThanOrEqual(2_560_000);
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
function isWhollyNumericBacktracking(v: string): boolean {
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
 * The same decision, plus one full extra pass over the input per 4000
 * characters. Superlinear, but with a constant small enough that the cost stays
 * inside the per-decision budget for a long way -- the shape an absolute bound
 * alone does not catch, used as the third negative control above.
 *
 * It delegates to the real implementation for the verdict, so it decides the
 * identical language by construction; there is no corpus assertion here because
 * there is nothing that could diverge.
 */
function isWhollyNumericSmallConstantSuperlinear(v: string): boolean {
  let sink = 0;
  for (let outer = 0; outer < Math.floor(v.length / 4000) + 1; outer++) {
    for (let i = 0; i < v.length; i++) {
      if (v[i] >= '0' && v[i] <= '9') sink += 1;
    }
  }
  // Keeps the loops above observable: without a use of `sink` an optimiser is
  // free to delete them, and the control would silently become the real scan.
  if (sink < 0) return false;
  return isWhollyNumeric(v);
}
