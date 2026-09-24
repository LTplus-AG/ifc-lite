/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelFact` — a fact about the element's MODEL rather than the element
 * (#5442): georeferencing, project units, STEP header fields. Every value
 * op works on it, like a property. Evaluated per element, reading that
 * element's model, so "the project is georeferenced" is an `IfcProject`
 * applicability plus `georef.crs isSet`, and a model-fact condition in
 * applicability scopes a rule to the models where it holds. Own module
 * because `filter-rules.ts` sits at the module-size cap.
 */

import { extractGeoreferencingOnDemand, parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
import type { TextKind, ValueOp } from './filter-rules.js';
import { valueOpMatches } from './filter-ops.js';
import { projectUnitsOf } from './measure-units.js';

export const MODEL_FACTS = [
  'georef.crs', 'georef.geodeticDatum', 'georef.verticalDatum', 'georef.mapProjection', 'georef.mapZone',
  'georef.eastings', 'georef.northings', 'georef.orthogonalHeight', 'georef.scale',
  'units.length', 'units.area', 'units.volume', 'units.angle', 'units.mass', 'units.time',
  'header.fileName', 'header.timeStamp', 'header.author', 'header.organization', 'header.originatingSystem',
  'header.preprocessorVersion', 'header.authorization', 'header.description', 'header.schema',
] as const;

export type ModelFact = (typeof MODEL_FACTS)[number];

export function isModelFact(value: unknown): value is ModelFact {
  return typeof value === 'string' && (MODEL_FACTS as readonly string[]).includes(value);
}

export interface ModelFactRule {
  kind: 'modelFact';
  fact: ModelFact;
  op: ValueOp;
  /** Raw user input. Numeric ops parse as numbers; isSet/isNotSet ignore. */
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

export function modelFactRule(fact: ModelFact, op: ValueOp, value: string, valueKind?: TextKind): ModelFactRule {
  return { kind: 'modelFact', fact, op, value, ...(valueKind ? { valueKind } : {}) };
}

const UNIT_MEASURE: Record<string, string> = {
  'units.length': 'IfcLengthMeasure',
  'units.area': 'IfcAreaMeasure',
  'units.volume': 'IfcVolumeMeasure',
  'units.angle': 'IfcPlaneAngleMeasure',
  'units.mass': 'IfcMassMeasure',
  'units.time': 'IfcTimeMeasure',
};

const headerCache = new WeakMap<object, ReturnType<typeof parseSourceHeader> | null>();

/** The model's STEP header: the parsed one on the store, else read once from its source. */
function headerOf(store: IfcDataStore): ReturnType<typeof parseSourceHeader> | undefined {
  if (store.sourceHeader) return store.sourceHeader;
  let header = headerCache.get(store);
  if (header === undefined) {
    header = (store.source?.length ? parseSourceHeader(store.source) : undefined) ?? null;
    headerCache.set(store, header);
  }
  return header ?? undefined;
}

const defined = (...values: Array<string | number | undefined | null>): Array<string | number> =>
  values.filter((v): v is string | number => v !== undefined && v !== null && v !== '');

/** The fact's values for `store`'s model; empty when the model does not state it. */
export function readModelFact(store: IfcDataStore, fact: ModelFact): Array<string | number> {
  if (fact.startsWith('units.')) {
    const units = projectUnitsOf(store);
    return defined(units?.unitForMeasure(UNIT_MEASURE[fact])?.symbol);
  }
  if (fact.startsWith('georef.')) {
    const georef = extractGeoreferencingOnDemand(store);
    const crs = georef?.projectedCRS;
    const conversion = georef?.mapConversion;
    switch (fact) {
      case 'georef.crs': return defined(crs?.name);
      case 'georef.geodeticDatum': return defined(crs?.geodeticDatum);
      case 'georef.verticalDatum': return defined(crs?.verticalDatum);
      case 'georef.mapProjection': return defined(crs?.mapProjection);
      case 'georef.mapZone': return defined(crs?.mapZone);
      case 'georef.eastings': return defined(conversion?.eastings);
      case 'georef.northings': return defined(conversion?.northings);
      case 'georef.orthogonalHeight': return defined(conversion?.orthogonalHeight);
      default: return defined(conversion?.scale);
    }
  }
  const header = headerOf(store);
  if (!header) return [];
  switch (fact) {
    case 'header.fileName': return defined(header.name);
    case 'header.timeStamp': return defined(header.timeStamp);
    case 'header.author': return defined(...header.author);
    case 'header.organization': return defined(...header.organization);
    case 'header.originatingSystem': return defined(header.originatingSystem);
    case 'header.preprocessorVersion': return defined(header.preprocessorVersion);
    case 'header.authorization': return defined(header.authorization);
    case 'header.description': return defined(...header.description);
    default: return defined(...header.schemaIdentifiers);
  }
}

/** Search semantics: presence ops ask whether the model states it; others pass when ANY value does. */
export function matchModelFactRule(rule: ModelFactRule, store: IfcDataStore): boolean {
  const values = readModelFact(store, rule.fact).map(String).filter((v) => v.trim() !== '');
  if (rule.op === 'isSet') return values.length > 0;
  if (rule.op === 'isNotSet') return values.length === 0;
  return values.some((v) => valueOpMatches(rule.op, v, rule.value, rule.valueKind));
}
