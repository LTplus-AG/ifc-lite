/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Length unit scales a model's reader has STATED, by `entityIndex`: for a
 * format with no `IfcProject`/`IfcUnitAssignment` to read (IFCX), where
 * {@link resolveLengthUnit} would otherwise find no `IFCPROJECT` and warn
 * "No IFCPROJECT found, defaulting to meters" on every call. See
 * {@link declareLengthUnitScale}.
 */
const declaredScales = new WeakMap<object, number>();

/**
 * Record the length unit scale a non-STEP model's format defines, so every
 * caller of {@link extractLengthUnitScale} (many read the unit from `source`
 * and `entityIndex` rather than from the store) gets it without hunting for
 * an `IFCPROJECT` the model cannot have. The scale is still reported as
 * `source: 'default'` (nothing in the file declares it); it just is not
 * re-diagnosed as a defect of the file.
 */
export function declareLengthUnitScale(entityIndex: object, scale: number): void {
  if (Number.isFinite(scale) && scale > 0) declaredScales.set(entityIndex, scale);
}

/** The scale {@link declareLengthUnitScale} recorded for this model; `undefined` when its format declared none. */
export function declaredLengthUnitScale(entityIndex: object): number | undefined {
  return declaredScales.get(entityIndex);
}
