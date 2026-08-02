/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Summary statistics for the B4.3 exam, split out of run.mjs (AGENTS.md: no
 * module over ~400 non-generated lines). Pure functions over arrays of
 * numbers; nothing here knows what a salt or a submission is.
 */

export const round = (v, d = 6) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const stdev = (xs) => {
  // A single sample has no spread to estimate: the Bessel divisor is 0, so the
  // unguarded form returns NaN, and every z-score derived from it becomes NaN
  // -> `null` in the scorecard, which reads as "not applicable" rather than as
  // "this was computed from one point". Return 0 and let the zero-spread guard
  // in `band` decide what a z-score means.
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Pearson correlation. Returns 0 rather than NaN when either side is constant. */
export function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return den === 0 ? 0 : num / den;
}

/**
 * Where one observed value sits inside a sample of nulls. `samples` is carried
 * verbatim so a reader can recompute every figure in this object.
 */
export function band(xs, obs) {
  return {
    mean: round(mean(xs)),
    stdev: round(stdev(xs), 8),
    min: round(Math.min(...xs)),
    max: round(Math.max(...xs)),
    samples: xs.map((v) => round(v)),
    observed: obs,
    // How many null samples the attack beats. An information-free attack
    // should land mid-pack; 0 or n is where you start looking harder.
    nullSamplesBelowObserved: xs.filter((v) => v < obs).length,
    // Explicit null when the nulls carry no spread (identical samples, or only
    // one). The unguarded division yields Infinity or NaN, both of which
    // JSON.stringify writes as `null` anyway - so the value in the artifact
    // would be the same while saying nothing about why. This says why.
    zScore: stdev(xs) === 0 ? null : round((obs - mean(xs)) / stdev(xs), 3),
  };
}
