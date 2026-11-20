/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison under the perf ratchet (#6959): one family's measured values
 * against its committed ceilings. This is the tolerance-aware generalisation
 * of `scripts/lib/count-ratchet.mjs` and keeps its meaning of "went up" and
 * "went down": a value above its allowance is a regression, a value below its
 * ceiling is an improvement. Two things differ, both deliberately:
 *
 *  - a row is never implied. count-ratchet reads an absent key as zero, which
 *    is right for "warnings in this file". Here an absent MEASUREMENT is a
 *    harness fault (`missing`), and a measured id with no committed ceiling is
 *    `unratcheted`; both fail, because "nothing was compared" is not a pass.
 *  - the allowance is `ceiling` widened by the entry's tolerance band.
 */

/** Statuses, in report order (the failing ones first). */
export const REGRESSION = 'regression';
export const MISSING = 'missing';
export const UNRATCHETED = 'unratcheted';
export const WITHIN_TOLERANCE = 'within-tolerance';
export const IMPROVEMENT = 'improvement';
export const UNCHANGED = 'unchanged';

export const FAILING_STATUSES = new Set([REGRESSION, MISSING, UNRATCHETED]);

/**
 * The largest value an entry admits. `exact` admits the ceiling itself;
 * `relative` admits `ceiling * (1 + value)`, floored so an integer metric
 * cannot pass on a fractional allowance.
 *
 * @param {{ ceiling: number, tolerance: { kind: string, value: number } }} entry
 */
export function allowedMax(entry) {
  if (entry.tolerance.kind === 'exact') return entry.ceiling;
  // `c + c*v`, not `c * (1 + v)`: 1.005 is not representable, and
  // 1000 * 1.005 evaluates to 1004.9999999999999, which floors a byte short.
  return Math.floor(entry.ceiling + entry.ceiling * entry.tolerance.value);
}

/**
 * Target ceiling for the daily job, or null if the entry should stay put.
 * Reserve headroom above main before testing for a drop. For a relative
 * metric, the target must also clear the tolerance band so small fluctuations
 * do not trigger a lowering PR.
 *
 * @param {{ ceiling: number, unit?: string, headroom?: number, tolerance: { kind: string, value: number } }} entry
 * @param {number} value
 */
export function loweringTarget(entry, value) {
  const bytes = entry.unit === 'bytes';
  const relative = entry.tolerance.kind === 'relative';
  const headroom = entry.headroom ?? (bytes && relative ? 0.005 : 0);
  // As in allowedMax, add the increment separately before rounding.
  const padded = value + value * headroom;
  const target = bytes ? Math.floor(padded) : padded;
  if (!(target < entry.ceiling)) return null;
  if (relative && target > entry.ceiling - entry.ceiling * entry.tolerance.value) return null;
  return target;
}

/** Signed change of `value` relative to `ceiling`, as a fraction (0.01 = +1%). */
export function relativeDelta(value, ceiling) {
  if (ceiling === 0) return value === 0 ? 0 : Infinity;
  return (value - ceiling) / ceiling;
}

/**
 * Compare one family.
 *
 * @param {{ family: string, entries: Array<object> }} ceilings validated ceiling file
 * @param {{ family: string, metrics: Array<{ id: string, value: number, detail?: string }> }} measured validated measured file
 * @returns {{ family: string, rows: Array<object>, informational: Array<object>, failed: boolean }}
 */
export function compareFamily(ceilings, measured) {
  if (ceilings.family !== measured.family) {
    throw new Error(`family mismatch: ceilings are \`${ceilings.family}\`, measurement is \`${measured.family}\``);
  }
  const byId = new Map(measured.metrics.map((m) => [m.id, m]));
  const rows = [];
  for (const entry of ceilings.entries) {
    const m = byId.get(entry.id);
    byId.delete(entry.id);
    const base = {
      id: entry.id,
      metric: entry.metric,
      unit: entry.unit,
      fixture: entry.fixture,
      ceiling: entry.ceiling,
      allowed: allowedMax(entry),
      tolerance: entry.tolerance,
    };
    if (!m) {
      rows.push({ ...base, value: null, status: MISSING, lowerable: false });
      continue;
    }
    let status;
    if (m.value > base.allowed) status = REGRESSION;
    else if (m.value > entry.ceiling) status = WITHIN_TOLERANCE;
    else if (m.value < entry.ceiling) status = IMPROVEMENT;
    else status = UNCHANGED;
    rows.push({ ...base, value: m.value, detail: m.detail, status, lowerable: loweringTarget(entry, m.value) !== null });
  }
  for (const m of byId.values()) {
    rows.push({ id: m.id, metric: null, ceiling: null, allowed: null, value: m.value, detail: m.detail, status: UNRATCHETED, lowerable: false });
  }
  // Informational values ride along to the report and never affect `failed` (#7007).
  const informational = measured.informational ?? [];
  return { family: ceilings.family, rows, informational, failed: rows.some((r) => FAILING_STATUSES.has(r.status)) };
}
