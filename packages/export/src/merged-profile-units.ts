/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractProjectUnits, measureUnit, type IfcDataStore, type ProjectUnits } from '@ifc-lite/parser';
import { PROFILE_MEASURE_POWERS } from './unit-normalize.js';

export function readProfileProjectUnits({ source, entityIndex }: IfcDataStore): ProjectUnits | undefined {
  if (source) return extractProjectUnits(source, entityIndex);
}

/** The declared unit's SI scale, or NaN when the project declares the unit but its scale cannot be resolved. */
function declaredScale(units: ProjectUnits | undefined, unitType: string, measure: string): number | undefined {
  const scale = units?.resolvedForUnitType(unitType)?.siScale;
  if (units?.unitForMeasure(measure) === null || (scale !== undefined && (!Number.isFinite(scale) || scale <= 0))) return NaN;
  return scale;
}

/** A measure's implicit unit: a power of the length unit, times the project mass unit for mass per length. */
function implicitScale(units: ProjectUnits | undefined, length: number, measure: string, power: number): number {
  if (measure !== 'IFCMASSPERLENGTHMEASURE') return length ** power;
  const mass = units?.unitForMeasure('IfcMassMeasure') === null ? NaN : units?.resolvedForUnitType('MASSUNIT')?.siScale ?? 1;
  return mass * length ** power;
}

/**
 * The factor of each profile measure, from the declared derived unit when a project has one and from
 * `implicitScale` otherwise. A NaN factor marks a declared
 * unit whose scale cannot be resolved: only scaling a value that inherits it fails (`profileFactor`).
 */
export function profileMeasureFactors(
  source: ProjectUnits | undefined, target: ProjectUnits | undefined,
  sourceLength: number, targetLength: number,
): ReadonlyMap<string, number> | undefined {
  if (!source && !target) return undefined;
  const factors = new Map<string, number>();
  for (const [measure, power] of PROFILE_MEASURE_POWERS) {
    const mapping = measureUnit(measure);
    if (mapping?.kind !== 'typed') continue;
    const sourceScale = declaredScale(source, mapping.unitType, measure);
    const targetScale = declaredScale(target, mapping.unitType, measure);
    factors.set(measure, (sourceScale ?? implicitScale(source, sourceLength, measure, power))
      / (targetScale ?? implicitScale(target, targetLength, measure, power)));
  }
  return factors;
}
