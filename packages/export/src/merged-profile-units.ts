/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractProjectUnits, measureUnit, type IfcDataStore, type ProjectUnits } from '@ifc-lite/parser';
import { PROFILE_MEASURE_POWERS } from './unit-normalize.js';

export function readProfileProjectUnits({ source, entityIndex }: IfcDataStore): ProjectUnits | undefined {
  if (source) return extractProjectUnits(source, entityIndex);
}

function declaredScale(units: ProjectUnits | undefined, unitType: string, measure: string): number | undefined {
  const scale = units?.resolvedForUnitType(unitType)?.siScale;
  if (units?.unitForMeasure(measure) === null || (scale !== undefined && (!Number.isFinite(scale) || scale <= 0))) {
    throw new Error(`Cannot normalize declared ${unitType}: its unit scale cannot be resolved`);
  }
  return scale;
}

/** Override the length-based factor when either project declares the derived unit. */
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
    if (sourceScale !== undefined || targetScale !== undefined) {
      factors.set(measure, (sourceScale ?? sourceLength ** power) / (targetScale ?? targetLength ** power));
    }
  }
  return factors.size > 0 ? factors : undefined;
}
