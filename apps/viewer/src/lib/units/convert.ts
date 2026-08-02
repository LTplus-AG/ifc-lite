/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Value conversion for the display-unit converter (issue #1573). Pure math,
 * no model access: every value stays whatever the file declared - only the
 * rendered number changes.
 */

import type { ResolvedUnit } from '@ifc-lite/parser';
import { alternativesForUnitType } from './alternatives.js';

/** A linear (plus optional affine offset) unit descriptor: converts a value
 *  in this unit to the SI base via `value*scale + (offset??0)`. */
export interface LinearUnit {
  scale: number;
  offset?: number;
}

/** Convert `value` (expressed in `from`) into `to`'s unit. Both go through
 *  the shared SI base, so a from/to pair with different offsets (e.g. °C ->
 *  K) round-trips correctly. `to` accepts any {@link LinearUnit} (a
 *  `UnitOption` already is one) so a file-declared unit - not just a curated
 *  alternative - can be a conversion target (issue #1573 follow-up: the
 *  Lists single-target normalization resolver). */
export function convertValue(value: number, from: LinearUnit, to: LinearUnit): number {
  const siBase = value * from.scale + (from.offset ?? 0);
  return (siBase - (to.offset ?? 0)) / to.scale;
}

/**
 * Resolve the file's declared unit for `unitType` into a `{scale, offset}`
 * pair usable as a `convertValue` source. When the file's symbol matches one
 * of our curated alternatives (e.g. its declared "°C" matches the
 * THERMODYNAMICTEMPERATUREUNIT option of the same symbol), reuse that
 * option's `offset` - `ProjectUnits.unitForMeasure` only carries a scale, so
 * without this an affine unit (temperature) would silently lose its offset
 * and convert as if it were purely multiplicative. Falls back to the file's
 * raw SI scale with no offset when the symbol isn't one we curate.
 */
export function resolveFromUnit(unitType: string, fileUnit: ResolvedUnit): LinearUnit {
  const match = alternativesForUnitType(unitType).find((opt) => opt.symbol === fileUnit.symbol);
  if (match) return { scale: match.scale, offset: match.offset ?? 0 };
  return { scale: fileUnit.siScale, offset: 0 };
}
