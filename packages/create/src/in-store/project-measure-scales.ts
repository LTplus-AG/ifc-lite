/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { extractProjectUnits, type IfcDataStore } from '@ifc-lite/parser';

export interface ProjectMeasureScales {
  readonly areaUnitScale: number;
  readonly volumeUnitScale: number;
  readonly planeAngleUnitScale: number;
}
const cache = new WeakMap<IfcDataStore, ProjectMeasureScales>();

/** SI per project unit; missing assignments use the parser's canonical SI defaults. */
export function projectMeasureScales(store: IfcDataStore): ProjectMeasureScales {
  const existing = cache.get(store);
  if (existing) return existing;
  const units = store.source?.length ? extractProjectUnits(store.source, store.entityIndex) : null;
  const scale = (type: string): number => {
    const resolved = units?.unitForMeasure(type);
    if (units && !resolved) throw new Error(`Cannot resolve the project's ${type} unit`);
    const value = resolved?.siScale ?? 1;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid project ${type} unit scale`);
    return value;
  };
  const result = { areaUnitScale: scale('IfcAreaMeasure'), volumeUnitScale: scale('IfcVolumeMeasure'), planeAngleUnitScale: scale('IfcPlaneAngleMeasure') };
  cache.set(store, result);
  return result;
}
