/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The length unit the Section bar speaks (#7545, D5): the project's own, so a
 * model authored in millimetres shows `-200 mm`, not `-0.200 m`. The store, the
 * renderer, saved sets, BCF and the SDK all stay in metres; this is only the
 * number the field shows and accepts, converted once at the edge.
 */

import { extractProjectUnits, type IfcDataStore } from '@ifc-lite/parser';

export interface LengthUnit {
  /** Metres per unit. */
  scale: number;
  /** What the field shows after the number. */
  symbol: string;
}

export const METRES: LengthUnit = { scale: 1, symbol: 'm' };

/** Symbols for the usual scales when a file declares no readable unit symbol. */
const SYMBOL_BY_SCALE: ReadonlyArray<readonly [number, string]> = [
  [0.001, 'mm'], [0.01, 'cm'], [1, 'm'], [0.0254, 'in'], [0.3048, 'ft'],
];

const cache = new WeakMap<object, LengthUnit>();

/** The unit of one model's lengths; metres when it declares none usable. */
export function projectLengthUnit(store: Pick<IfcDataStore, 'source' | 'entityIndex' | 'lengthUnitScale' | 'spatialHierarchy'> | null | undefined): LengthUnit {
  if (!store) return METRES;
  const cached = cache.get(store);
  if (cached) return cached;
  let resolved: LengthUnit = METRES;
  try {
    const declared = store.source?.length
      ? extractProjectUnits(store.source, store.entityIndex, store.spatialHierarchy?.project?.expressId).resolvedForUnitType('LENGTHUNIT')
      : undefined;
    const scale = declared?.siScale ?? store.lengthUnitScale;
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
      const known = SYMBOL_BY_SCALE.find(([s]) => Math.abs(s - scale) <= s * 1e-9)?.[1];
      resolved = { scale, symbol: declared?.symbol || known || 'm' };
      // A unit with no way to name it is shown in metres rather than mislabelled.
      if (!declared?.symbol && !known) resolved = METRES;
    }
  } catch (error) {
    console.warn('[section] project length unit unreadable; showing metres', error);
  }
  cache.set(store, resolved);
  return resolved;
}

/** The unit for a scene: the first visible model that declares one, else metres. */
export function sceneLengthUnit(models: Iterable<{ visible?: boolean; ifcDataStore?: Parameters<typeof projectLengthUnit>[0] | null }>): LengthUnit {
  for (const model of models) {
    if (model.visible === false || !model.ifcDataStore) continue;
    return projectLengthUnit(model.ifcDataStore);
  }
  return METRES;
}
