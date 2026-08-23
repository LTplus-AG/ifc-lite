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
   * `SPEC_RE` is quadratic on a failing match: `\d+\.?\d*` retries at every
   * split point before the engine gives up. Its caller is the CSV formula
   * guard, which reaches it only after a trigger character matched -- so `-`
   * followed by tens of thousands of digits, an ordinary attacker-controllable
   * IFC property value, froze an export.
   *
   * Asserted as a RATIO between the two on the same input on the same machine,
   * so a fast or slow runner moves both ends together and there is no absolute
   * millisecond bound to re-tune. A ratio alone would be satisfied by 0 vs 0,
   * so it is paired with a floor proving the slow half took measurable time.
   */
  const hostile = `-${'1'.repeat(30_000)}x`;
  const elapsed = (f: () => void): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };

  it('rejects the hostile input, so the timings below measure a real decision', () => {
    expect(isWhollyNumeric(hostile)).toBe(false);
  });

  it('runs orders of magnitude faster than the regex it replaced', () => {
    const regexMs = elapsed(() => void SPEC_RE.test(hostile));
    const scanMs = elapsed(() => void isWhollyNumeric(hostile));
    // Floor: if the backtracking half finished instantly, the ratio below would
    // compare two zeroes and pass against any implementation at all.
    expect(regexMs).toBeGreaterThan(50);
    // Measured gap is ~10,000x, so 50x is far out of reach of timing noise and
    // still unreachable for anything that backtracks.
    expect(scanMs * 50).toBeLessThan(regexMs);
  });
});
