/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type Dimensions = { width: number; height: number; cssWidth: number; cssHeight: number };

/** Refuse absent, nonnumeric, nonfinite or empty dimension observations. */
export function requireDimensions(value: unknown): asserts value is Dimensions {
  if (typeof value !== 'object' || value === null) throw Error('Missing frame dimension observation');
  const fields = value as Record<string, unknown>;
  for (const key of ['width', 'height', 'cssWidth', 'cssHeight']) {
    const dimension = fields[key];
    if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0) {
      throw Error(`Missing, nonfinite or nonpositive frame dimension: ${key}`);
    }
  }
}

/** Check both measured buffer axes against the requested finite pixel ratio. */
export function fullQuality(value: unknown, dpr: unknown): void {
  requireDimensions(value);
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) throw Error('Invalid expected frame pixel ratio');
  if (Math.abs(value.width - Math.round(value.cssWidth * dpr)) > 1 ||
      Math.abs(value.height - Math.round(value.cssHeight * dpr)) > 1) {
    throw Error('Full-quality drawing-buffer dimensions not restored');
  }
}
