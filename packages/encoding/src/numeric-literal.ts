/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether `v` is WHOLLY a signed decimal number, optionally in exponent form:
 * `-0.35`, `+1`, `-1.5e-3`, `-.5`, `-1.`. Anchored at BOTH ends, so `-0.35=cmd`
 * is not one and `1,000` is not one either.
 *
 * Lives here, in a package with no dependencies, because three different
 * callers need it and only two of them can afford `@ifc-lite/export`: the CSV
 * formula guard (`packages/export/src/csv-cell.ts`) exempts a genuine number
 * from the `+`/`-` trigger so a spreadsheet column still sums (#1772), and
 * `@ifc-lite/lists` needs the same decision in its own CSV writer.
 * `rust/export/src/csv_cell.rs::is_wholly_numeric` decides the same language on
 * the other side of the language boundary; what holds those two together is the
 * shared vector fixture, not a promise that they look alike.
 *
 * The regex this replaces — `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/` —
 * is QUADRATIC on a failing match: `\d+\.?\d*` retries at every split point
 * before the engine gives up. This scan is linear, which is the whole reason it
 * is spelled out by hand. (For scale, on `-` + 60k digits + one letter the
 * regex took ~1.8s and the scan ~1ms; the ratio is the point, not the numbers.)
 *
 * Cell text comes from IFC properties, so the input is attacker-controllable and
 * a leading `-` is exactly what reaches this check. `\d` is ASCII-only in JS, and
 * this scan matches that deliberately: a full-width or Arabic-Indic digit is NOT
 * a number here and stays guarded.
 */
export function isWhollyNumeric(v: string): boolean {
  const n = v.length;
  let i = 0;
  if (i < n && (v[i] === '+' || v[i] === '-')) i++;

  // Mantissa: `\d+\.?\d*` or `\.\d+` — at least one digit either way.
  let digits = 0;
  while (i < n && v[i] >= '0' && v[i] <= '9') { i++; digits++; }
  if (i < n && v[i] === '.') {
    i++;
    while (i < n && v[i] >= '0' && v[i] <= '9') { i++; digits++; }
  }
  if (digits === 0) return false;

  // Optional exponent, which must carry at least one digit if present.
  if (i < n && (v[i] === 'e' || v[i] === 'E')) {
    i++;
    if (i < n && (v[i] === '+' || v[i] === '-')) i++;
    let expDigits = 0;
    while (i < n && v[i] >= '0' && v[i] <= '9') { i++; expDigits++; }
    if (expDigits === 0) return false;
  }

  // Anchored at the end: trailing anything, including a newline, disqualifies.
  return i === n;
}
