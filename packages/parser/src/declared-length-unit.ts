/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LengthUnitSource, ResolvedLengthUnit } from './length-unit-source.js';

/**
 * Length unit scales a model's reader has STATED, by `entityIndex`: for a
 * format with no `IfcProject`/`IfcUnitAssignment` to read (IFCX), where
 * {@link resolveLengthUnit} would otherwise find no `IFCPROJECT` and warn
 * "No IFCPROJECT found, defaulting to meters" on every call. See
 * {@link declareLengthUnitScale}.
 */
const declaredScales = new WeakMap<object, ResolvedLengthUnit>();

/**
 * Record the length unit scale a non-STEP model's format defines, so every
 * caller of {@link extractLengthUnitScale} (many read the unit from `source`
 * and `entityIndex` rather than from the store) gets it without hunting for
 * an `IFCPROJECT` the model cannot have. `source` says where the reader got
 * it: `'default'` when the format assumes the unit and nothing in the file
 * declares it (IFCX), `'declared'` when the file states it. Either way it is
 * not re-diagnosed as a defect of the file.
 */
export function declareLengthUnitScale(entityIndex: object, scale: number, source: LengthUnitSource = 'default'): void {
  if (Number.isFinite(scale) && scale > 0) declaredScales.set(entityIndex, { scale, source });
}

/** What {@link declareLengthUnitScale} recorded for this model; `undefined` when its reader stated none. */
export function declaredLengthUnitScale(entityIndex: object): ResolvedLengthUnit | undefined {
  return declaredScales.get(entityIndex);
}
