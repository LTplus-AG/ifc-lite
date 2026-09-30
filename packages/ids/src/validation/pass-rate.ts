/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one pass-percentage rounding rule (#6470).
 *
 * A bare `Math.floor(passed / total * 100)` reads `0%` for 70 of 7,972
 * passing (0.9%) and `100%` for 9,999 of 10,000, both of which tell a
 * reader something false: "nothing passes" / "nothing fails". A partial
 * result is therefore kept strictly inside 1..99. No entities to measure
 * reads 100, the same convention `calculateSummary` always used.
 */
export function boundedPassRate(passed: number, total: number): number {
  if (total <= 0) return 100;
  if (passed <= 0) return 0;
  if (passed >= total) return 100;
  return Math.min(99, Math.max(1, Math.floor((passed / total) * 100)));
}

/** Colour band for a pass rate: shared by the panel bar, the document preview and the PDF. */
export type PassRateBand = 'good' | 'warn' | 'bad';

export function passRateBand(passRate: number): PassRateBand {
  return passRate >= 80 ? 'good' : passRate >= 50 ? 'warn' : 'bad';
}
