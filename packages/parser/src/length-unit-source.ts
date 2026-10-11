/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a project length-unit scale came from (#7395), shared by the unit
 * walk in `unit-extractor.ts` and the parse in `columnar-parser.ts`.
 *
 * `declared` when the project's IFCUNITASSIGNMENT declares a LENGTHUNIT
 * that resolves; `default` when the scale is the unconfirmed 1.0 (metres)
 * every other path falls back to (#2104).
 */
export type LengthUnitSource = 'declared' | 'default';

/** A resolved project length unit: its scale, where it came from, and why it defaulted. */
export interface ResolvedLengthUnit {
  scale: number;
  source: LengthUnitSource;
  /** Why the scale defaulted to metres; set only when `source` is `default`. */
  reason?: string;
}

export const declared = (scale: number): ResolvedLengthUnit => ({ scale, source: 'declared' });
export const defaulted = (reason: string): ResolvedLengthUnit => ({ scale: 1.0, source: 'default', reason });

/**
 * The sentence both channels carry for a unit that defaulted to metres: the
 * console prefixes it with `[UnitExtractor] ` (unchanged since #2104), and
 * `onDiagnostic` with `units: `, so the two cannot drift apart.
 */
export function unknownUnitMessage(reason: string): string {
  return `${reason}, defaulting to meters (unconfirmed — see issue #2104)`;
}
