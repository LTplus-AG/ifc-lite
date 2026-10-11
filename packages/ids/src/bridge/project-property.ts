/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Projection of one raw parser property record into the validator's
 * `PropertySetInfo['properties'][number]` shape: IDS dataType resolution and
 * SI conversion (#7395). Split out of properties.ts to keep that module
 * under its size budget.
 */

import type { PropertySetInfo } from '../types.js';
import { idsDataTypeForProperty } from './data-types.js';
import {
  applyOwnUnitConversion,
  applyUnitConversion,
  type EntityMeasureScales,
} from './units.js';

export interface RawProp {
  name: string;
  value: unknown;
  type: unknown;
  values?: string[];
  dataType?: string;
  dataTypeMixed?: true;
  /** IFC type of each entry of `values` when the members share none. */
  valueDataTypes?: Array<string | undefined>;
  /** The property's own explicit `Unit` symbol; `#<id>` when it could not be resolved. */
  unit?: string;
  /** SI factor of `unit`, only when it resolved. */
  unitSiScale?: number;
}

type ProjectedProperty = PropertySetInfo['properties'][number];

/** A property's own `Unit`, as the parser resolved it. */
export interface OwnUnit {
  symbol: string;
  siScale: number | undefined;
}

/**
 * The own `Unit` of each projected property that declares one, keyed by the
 * projected object. Kept off the public `PropertySetInfo` shape; an overlay
 * correction reads it to convert its value in that unit rather than in the
 * project's (see property-overlay-resolver.ts).
 */
const ownUnits = new WeakMap<object, OwnUnit>();

export function ownUnitOf(prop: object): OwnUnit | undefined {
  return ownUnits.get(prop);
}

/** Carry `from`'s own unit over to a copy of it. */
export function copyOwnUnit(from: object, to: object): void {
  const unit = ownUnits.get(from);
  if (unit) ownUnits.set(to, unit);
}

/**
 * The IDS dataType of a raw property. The source's own tag wins. A
 * multi-valued property without one is UNKNOWN: its display type says
 * nothing about its members, so no type is invented. Only an explicit
 * `dataTypeMixed` (a table) exempts a property from a dataType check (#5224).
 */
function idsDataTypeOf(p: RawProp): Pick<ProjectedProperty, 'dataType' | 'dataTypeMixed'> {
  const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
  const dataType = p.dataType ?? (hasMultiValue ? undefined : idsDataTypeForProperty(p.type as number | string | undefined));
  return { dataType, ...(p.dataTypeMixed ? { dataTypeMixed: true } : {}) };
}

/**
 * Project a raw parser property record — applies SI conversion and resolves
 * the IDS dataType (`idsDataTypeOf`). A declared own `Unit` replaces the
 * project assignment for this value (#7395); only a value without one takes
 * the project unit.
 */
export function projectProperty(p: RawProp, scales: EntityMeasureScales): ProjectedProperty {
  const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
  const types = idsDataTypeOf(p);
  const dataType = types.dataType;
  const baseValue = Array.isArray(p.value)
    ? JSON.stringify(p.value)
    : (p.value as string | number | boolean | null);
  const baseValues = hasMultiValue ? (p.values as string[]) : undefined;
  const converted =
    p.unit !== undefined
      ? applyOwnUnitConversion(baseValue, baseValues, dataType, p.unitSiScale, p.unit)
      : applyUnitConversion(baseValue, baseValues, dataType, scales.length, scales, p.valueDataTypes);
  const out: ProjectedProperty = {
    name: p.name,
    value: converted.value,
    ...types,
    ...(converted.values ? { values: converted.values } : {}),
  };
  if (p.unit !== undefined) ownUnits.set(out, { symbol: p.unit, siScale: p.unitSiScale });
  return out;
}
