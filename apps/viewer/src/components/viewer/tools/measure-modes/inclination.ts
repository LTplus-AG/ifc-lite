/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inclination (angle to horizontal) of a point-to-point measurement — issue
 * #2199 §4, the part that needs no new picking interaction.
 *
 * Pure display maths over the two endpoints already stored on a Measurement,
 * exactly like {@link distanceComponents}: nothing is persisted, nothing is
 * re-picked. It consumes the horizontal / vertical split rather than the raw
 * deltas so it inherits that module's Y-up axis convention instead of
 * restating it — see `components.ts`, which is where the "viewer space is
 * Y-up" decision lives.
 */

import type { DistanceComponents } from './components';

/**
 * Which of the four genuinely different answers a segment has.
 *
 * This is not decoration. A LEVEL run and a DEGENERATE zero-length pick
 * produce the identical `(0 degrees, 0 percent, no ratio)` triple, so without
 * a discriminator a formatter cannot tell "I measured along the floor" from
 * "I measured nothing" — and would have to report one of them as the other.
 */
export type InclinationKind =
  /** Both endpoints coincide: there is no segment, so no inclination. */
  | 'degenerate'
  /** Non-zero run, zero rise: horizontal. */
  | 'level'
  /** Zero run, non-zero rise: plumb. */
  | 'vertical'
  /** Both non-zero: a real gradient. */
  | 'sloped';

export interface Inclination {
  kind: InclinationKind;
  /**
   * Angle between the measured segment and the horizontal ground plane, in
   * degrees, always in [0, 90]. Unsigned: a fall of 30 degrees and a rise of
   * 30 degrees both read 30. The DIRECTION is already carried by the signed
   * `dY` in the axis-delta line, so signing this too would say the same thing
   * twice while inviting the reader to think 0 is a floor rather than level.
   */
  degrees: number;
  /**
   * Slope as a percentage: rise over run times 100. `Infinity` for a purely
   * vertical segment (zero run), which is a real answer and not an error —
   * `formatInclination` renders that case as "vertical" rather than a number.
   */
  percent: number;
  /**
   * The `n` in a 1:n slope ratio — the run travelled per unit of rise. `null`
   * when there is no rise at all, because 1:infinity is not a ratio anybody
   * writes on a drawing.
   *
   * NOTE the direction of this fraction. Construction slope ratios are
   * written 1 vertical to n horizontal (a 1:20 fall), so this is
   * `horizontal / vertical` — the RECIPROCAL of the percentage's fraction.
   * Inverting it turns a shallow drainage fall into a near-vertical one.
   */
  ratioRun: number | null;
}

/**
 * Derive the inclination of a measured segment from its horizontal / vertical
 * split.
 *
 * Degenerate cases are answered rather than thrown:
 * - zero-length segment: `degenerate`, 0 degrees, 0 percent, no ratio;
 * - level run: `level`, 0 degrees, 0 percent, no ratio;
 * - plumb drop: `vertical`, 90 degrees, Infinity percent, ratio 0.
 */
export function inclination(c: DistanceComponents): Inclination {
  const { horizontal, vertical } = c;

  const kind: InclinationKind =
    horizontal === 0
      ? (vertical === 0 ? 'degenerate' : 'vertical')
      : (vertical === 0 ? 'level' : 'sloped');

  // atan2 rather than atan(v/h) so the zero-run case yields 90 instead of
  // dividing by zero, and the zero-length case yields 0 instead of NaN.
  const degrees = (Math.atan2(vertical, horizontal) * 180) / Math.PI;

  const percent = horizontal === 0
    // A plumb drop has infinite gradient; a coincident pair has none.
    // Collapsing both to 0 (or both to Infinity) would report one of them
    // wrongly.
    ? (vertical === 0 ? 0 : Infinity)
    : (vertical / horizontal) * 100;

  const ratioRun = vertical === 0 ? null : horizontal / vertical;

  return { kind, degrees, percent, ratioRun };
}

/**
 * One-line inclination readout, e.g. `12.5°  22.2%  1:4.5`.
 *
 * The three forms are shown together on purpose: degrees is what a surveyor
 * reads, percent is what a road or ramp gradient is specified in, and 1:n is
 * what a drainage fall is drawn as. Picking one would make the tool useless to
 * two of those three readers.
 */
export function formatInclination(i: Inclination): string {
  switch (i.kind) {
    // Em-dash, not "0°": nothing was measured, so claiming it was level would
    // state a fact the pick never established.
    case 'degenerate': return '—';
    case 'level': return '0.0°  0.0%  level';
    case 'vertical': return '90.0°  vertical';
    case 'sloped':
      return `${i.degrees.toFixed(1)}°  ${i.percent.toFixed(1)}%  1:${(i.ratioRun ?? 0).toFixed(1)}`;
  }
}
