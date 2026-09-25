/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The project-unit lookups `readSubject` needs to say what unit a property
 * or quantity value is recorded in (#5300) and what factor turns it into SI
 * (#5225). One memoised `ProjectUnits` per store, from the same
 * `extractProjectUnits` resolver that backs unit display and the IDS
 * bridge's scaling.
 */

import {
  extractProjectUnits,
  quantitySiScale,
  type IfcDataStore,
  type ProjectUnits,
} from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';

const projectUnitsCache = new WeakMap<object, ProjectUnits | null>();

/** `store`'s project units, or `null` when the store has no source to read them from. */
export function projectUnitsOf(store: IfcDataStore): ProjectUnits | null {
  let units = projectUnitsCache.get(store);
  if (units === undefined) {
    units = store.source?.length && store.entityIndex ? extractProjectUnits(store.source, store.entityIndex) : null;
    projectUnitsCache.set(store, units);
  }
  return units;
}

export const QUANTITY_MEASURE_TYPE: Partial<Record<QuantityType, string>> = {
  [QuantityType.Length]: 'IfcLengthMeasure',
  [QuantityType.Area]: 'IfcAreaMeasure',
  [QuantityType.Volume]: 'IfcVolumeMeasure',
  [QuantityType.Weight]: 'IfcMassMeasure',
  [QuantityType.Time]: 'IfcTimeMeasure',
};

/** The project's display unit for IFC measure type `measureType`, if any. */
export function projectUnitSymbol(store: IfcDataStore, measureType: string | undefined): string | undefined {
  if (!measureType) return undefined;
  return projectUnitsOf(store)?.unitForMeasure(measureType)?.symbol;
}

/**
 * SI factor of a value of IFC measure type `measureType` recorded in the
 * project's units, or `undefined` when the type has no unit (a label, a
 * count, a ratio). Area and volume use the project's declared AREAUNIT /
 * VOLUMEUNIT and fall back to the length unit squared / cubed, the rule
 * `quantitySiScale` and the IDS bridge already apply.
 */
export function projectSiScale(store: IfcDataStore, measureType: string | undefined): number | undefined {
  if (!measureType) return undefined;
  const units = projectUnitsOf(store);
  if (!units) return undefined;
  const upper = measureType.toUpperCase();
  const length = () => units.unitForMeasure('IfcLengthMeasure')?.siScale ?? 1;
  if (upper === 'IFCAREAMEASURE') return units.resolvedForUnitType('AREAUNIT')?.siScale ?? length() ** 2;
  if (upper === 'IFCVOLUMEMEASURE') return units.resolvedForUnitType('VOLUMEUNIT')?.siScale ?? length() ** 3;
  return units.unitForMeasure(measureType)?.siScale;
}

/** SI factor of one collected quantity: its explicit `Unit`, else the project unit for its type. */
export function quantityValueSiScale(
  store: IfcDataStore,
  quantity: { type: number; value: number; explicitUnitSiScale?: number },
): number | undefined {
  if (quantity.explicitUnitSiScale !== undefined) return quantity.explicitUnitSiScale;
  const measureType = QUANTITY_MEASURE_TYPE[quantity.type as QuantityType];
  if (!measureType) return undefined;
  const units = projectUnitsOf(store);
  if (!units) return undefined;
  if (quantity.type === QuantityType.Length || quantity.type === QuantityType.Area || quantity.type === QuantityType.Volume) {
    return quantitySiScale({ name: '', ...quantity }, units);
  }
  return projectSiScale(store, measureType);
}
