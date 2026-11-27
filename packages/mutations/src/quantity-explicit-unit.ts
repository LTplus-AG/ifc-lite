/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Quantity } from '@ifc-lite/data';
import type { QuantityMutation } from './types.js';

/**
 * The explicit `Unit` an edited quantity keeps (#11592). An edit changes the
 * number, not the unit it is measured in, so the base quantity's own `Unit`
 * and its SI scale stay with it, also when the edit repeats that unit's symbol.
 * They are dropped when the edit removes the unit, names another unit (a
 * symbol with no known scale) or changes the quantity type, because the base
 * unit no longer describes the value.
 */
export function keptExplicitUnit(base: Quantity, mutation: QuantityMutation): Pick<Quantity, 'explicitUnit' | 'explicitUnitSiScale' | 'explicitUnitUnresolved'> {
  const namesOtherUnit = mutation.unit !== undefined && mutation.unit !== base.explicitUnit;
  if (mutation.unitRemoved || namesOtherUnit || (mutation.quantityType !== undefined && mutation.quantityType !== base.type)) return {};
  const { explicitUnit, explicitUnitSiScale, explicitUnitUnresolved } = base;
  return {
    ...(explicitUnit !== undefined ? { explicitUnit } : {}),
    ...(explicitUnitSiScale !== undefined ? { explicitUnitSiScale } : {}),
    ...(explicitUnitUnresolved ? { explicitUnitUnresolved } : {}),
  };
}
