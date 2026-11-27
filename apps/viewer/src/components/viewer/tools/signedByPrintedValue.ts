/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format `|value|` and sign it by what is PRINTED, not by the raw value: a
 * value that rounds to zero reads as zero, never `-0` or `+0`, because a sign
 * on nothing claims a direction (#11465). Comparing against the formatted
 * zero keeps this locale-safe. `plus` adds `+` to positive values.
 */
export function signedByPrintedValue(value: number, format: (magnitude: number) => string, plus: boolean): string {
  const magnitude = format(Math.abs(value));
  if (Number.isNaN(value) || magnitude === format(0)) return magnitude;
  if (value < 0) return `-${magnitude}`;
  return plus ? `+${magnitude}` : magnitude;
}
