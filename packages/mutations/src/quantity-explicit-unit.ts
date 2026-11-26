/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Quantity } from '@ifc-lite/data';
import type { QuantityMutation } from './types.js';

/** The explicit-unit metadata a quantity collector attaches to a quantity that declares its own `Unit`. */
interface ExplicitUnitFields {
  explicitUnit?: string;
  explicitUnitSiScale?: number;
  explicitUnitUnresolved?: true;
}

/**
 * The explicit `Unit` an edited quantity keeps (#11592). An edit changes the
 * number, not the unit it is measured in, so the base quantity's own `Unit`
 * and its SI scale stay with it. They are dropped when the edit removes the
 * unit, names a unit of its own (a symbol with no known scale) or changes the
 * quantity type, because the base unit no longer describes the value.
 */
export function keptExplicitUnit(base: Quantity, mutation: QuantityMutation): ExplicitUnitFields {
  if (mutation.unitRemoved || mutation.unit || (mutation.quantityType !== undefined && mutation.quantityType !== base.type)) return {};
  const { explicitUnit, explicitUnitSiScale, explicitUnitUnresolved } = base as Quantity & ExplicitUnitFields;
  return {
    ...(explicitUnit !== undefined ? { explicitUnit } : {}),
    ...(explicitUnitSiScale !== undefined ? { explicitUnitSiScale } : {}),
    ...(explicitUnitUnresolved ? { explicitUnitUnresolved } : {}),
  };
}
