/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW: the #418 candidate tolerance rule.
 *
 * IDS 1.0 (`Documentation/ImplementersDocumentation/tolerance.md`) states
 * `x == v ⇒ (v - |v|·ε - ε) < x < (v + |v|·ε + ε)` with ε = 1e-6, strict
 * comparisons, and the official test cases cannot all pass under that text.
 * buildingSMART/IDS#418 (milestone 1.1, "discuss & decide") proposes the
 * documentation be changed to inclusive comparisons and that the 15-decimal
 * rounding the reference implementation applies be written down. A comment
 * on the issue reproduces that rounding as "Math.Round(bound, 15) on the
 * bounds only, 15 decimal places, banker's rounding, then >= and <=", and
 * reports zero disagreements on the official cases with it.
 *
 * Conservative reading taken here (recorded in the P-12 worklog): the
 * tolerance stays fixed and non-configurable (upstream: "the tolerance
 * value is not configurable"), only equality uses it (ranges never do),
 * and the bounds are computed as `v - |v|·ε - ε` / `v + |v|·ε + ε` in
 * double arithmetic, then rounded half-to-even to 15 decimal places.
 */

const EPSILON = 1e-6;
const DECIMALS = 15;

/**
 * `x` rounded to `decimals` decimal places, ties to even, decided on the
 * exact binary value of `x` (as .NET `Math.Round(double, int)` does for the
 * values it can represent). `toFixed(100)` gives the exact decimal
 * expansion for every double whose expansion fits in 100 fraction digits,
 * which covers all magnitudes the tolerance rule produces above 1e-30; for
 * smaller ones the tie test can only see zeros, which is the correct answer
 * at 15 places anyway.
 */
export function roundHalfEven(x: number, decimals: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  // ES2018 raised toFixed's limit from 20 to 100 digits; the exact expansion needs it.
  // eslint-disable-next-line number-arg-out-of-range
  const [intPart, frac = ''] = Math.abs(x).toFixed(100).split('.');
  const kept = frac.slice(0, decimals);
  const rest = frac.slice(decimals);
  let roundUp = false;
  if (rest[0] !== undefined && rest[0] > '5') roundUp = true;
  else if (rest[0] === '5') {
    const exactTie = /^0*$/.test(rest.slice(1));
    const last = Number((intPart + kept).slice(-1));
    roundUp = !exactTie || last % 2 === 1;
  }
  // Increment on the decimal digits (BigInt), so the only binary rounding
  // is the final `Number(...)` of the already-rounded decimal string.
  const scaled = (BigInt(intPart + kept) + (roundUp ? 1n : 0n)).toString().padStart(decimals + 1, '0');
  const magnitude = decimals === 0 ? Number(scaled) : Number(`${scaled.slice(0, -decimals)}.${scaled.slice(-decimals)}`);
  return x < 0 ? -magnitude : magnitude;
}

/** The inclusive `[lower, upper]` an IDS 1.1 PREVIEW (#418) equality accepts for `v`. */
export function ids11ToleranceBounds(v: number): [number, number] {
  const spread = Math.abs(v) * EPSILON;
  return [roundHalfEven(v - spread - EPSILON, DECIMALS), roundHalfEven(v + spread + EPSILON, DECIMALS)];
}

/** `actual` equals the IDS literal `expected` under the #418 candidate rule. */
export function equalsWithIds11Tolerance(expected: number, actual: number): boolean {
  const [lower, upper] = ids11ToleranceBounds(expected);
  return lower <= actual && actual <= upper;
}
