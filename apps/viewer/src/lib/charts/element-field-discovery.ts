/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discovery of chartable IFC fields (#4833): what value shapes a field was
 * seen with, merged across chunks and models, and the one interpretation
 * (`valueKind`, `dataType`, `unit`) inferred from the merged record.
 *
 * Observations merge, bindings do not. Inferring a kind per model and then
 * reconciling two bindings is order-dependent by construction — "number"
 * meeting "category" has no rule that is right for both orders — so the
 * catalog hook merges the raw observations and infers once, at the end.
 */
import type { ElementFieldBinding, ElementFieldValueKind } from '@ifc-lite/charts';
import { normalizeElementFieldValue } from '@ifc-lite/charts';
import { measureUnit } from '@ifc-lite/parser';
import type { Property } from '@ifc-lite/data';

export interface ElementFieldOption {
  binding: ElementFieldBinding;
  label: string;
  /** False when the field exists but every inspected value is missing. */
  observedValue: boolean;
}

export interface ElementFieldCatalog {
  attributes: ElementFieldOption[];
  properties: Map<string, ElementFieldOption[]>;
}

/** The value shapes one field was seen with. Sets union, flags OR, so two records merge losslessly. */
export interface ObservedKind {
  text: boolean;
  number: boolean;
  boolean: boolean;
  units: Set<string>;
  dataTypes: Set<string>;
}

export interface PropertyObservation {
  psetName: string;
  propertyName: string;
  kind: ObservedKind;
}

export interface ElementFieldObservations {
  /** Attribute name → shapes; only attributes the schema declares as scalars are recorded. */
  attributes: Map<string, ObservedKind>;
  /** `JSON.stringify([psetName, propertyName])` → shapes. */
  properties: Map<string, PropertyObservation>;
}

export function emptyObservation(): ObservedKind {
  return { text: false, number: false, boolean: false, units: new Set(), dataTypes: new Set() };
}

export function emptyObservations(): ElementFieldObservations {
  return { attributes: new Map(), properties: new Map() };
}

function mergeKind(into: ObservedKind, from: ObservedKind): void {
  into.text ||= from.text;
  into.number ||= from.number;
  into.boolean ||= from.boolean;
  for (const unit of from.units) into.units.add(unit);
  for (const dataType of from.dataTypes) into.dataTypes.add(dataType);
}

/** Fold `from` into `into`. Commutative and associative, so model order cannot change the catalog. */
export function mergeObservations(into: ElementFieldObservations, from: ElementFieldObservations): void {
  for (const [name, kind] of from.attributes) {
    const target = into.attributes.get(name);
    if (target) mergeKind(target, kind);
    else into.attributes.set(name, { ...kind, units: new Set(kind.units), dataTypes: new Set(kind.dataTypes) });
  }
  for (const [key, observation] of from.properties) {
    const target = into.properties.get(key);
    if (target) mergeKind(target.kind, observation.kind);
    else into.properties.set(key, { ...observation, kind: { ...observation.kind, units: new Set(observation.kind.units), dataTypes: new Set(observation.kind.dataTypes) } });
  }
}

export function propertyObservationKey(psetName: string, propertyName: string): string {
  return JSON.stringify([psetName, propertyName]);
}

/**
 * Record one property occurrence. A property with candidate `values` — an
 * enumerated, list, bounded or table value — is a SHAPE, not a scalar: it is
 * recorded as text only (its joined display string is its category), never
 * as a number, whatever its member count. A one-member list is still a list,
 * and a bound with only an upper value is still a range (#4833).
 */
export function observeProperty(observed: ObservedKind, property: Property): void {
  // An explicit unit that did not resolve (`#123`, no scale) names no unit
  // the column could be labelled with; the rows carrying it read unsupported.
  if (property.unit && property.unitSiScale !== undefined) observed.units.add(property.unit);
  if (property.dataType) observed.dataTypes.add(property.dataType.toUpperCase());
  if (property.values) {
    if (typeof property.value === 'string' && property.value.trim()) observed.text = true;
    return;
  }
  const normalized = normalizeElementFieldValue(property.value, typeof property.value === 'number' ? 'number' : typeof property.value === 'boolean' ? 'boolean' : 'category');
  if (normalized.status !== 'value') return;
  if (typeof normalized.value === 'number') observed.number = true;
  else if (typeof normalized.value === 'boolean') observed.boolean = true;
  else observed.text = true;
}

/** Record one raw attribute value, with the EXPRESS type the schema declares for it. */
export function observeAttribute(observed: ObservedKind, raw: unknown, declaredType?: string): void {
  if (declaredType) observed.dataTypes.add(declaredType.toUpperCase());
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'string' && raw[0].toUpperCase().startsWith('IFC')) {
    observed.dataTypes.add(raw[0].toUpperCase());
  }
  const numeric = normalizeElementFieldValue(raw, 'number');
  const logical = normalizeElementFieldValue(raw, 'boolean');
  const normalized = numeric.status === 'value'
    ? numeric
    : logical.status === 'value'
      ? logical
      : normalizeElementFieldValue(raw, 'category');
  if (normalized.status !== 'value') return;
  if (typeof normalized.value === 'number') observed.number = true;
  else if (typeof normalized.value === 'boolean') observed.boolean = true;
  else observed.text = true;
}

export function inferKind(observed: ObservedKind): ElementFieldValueKind {
  if (!observed.text && !observed.number && !observed.boolean && observed.dataTypes.size > 0) {
    const measures = [...observed.dataTypes].map(measureUnit);
    if (measures.every((measure) => measure?.kind === 'typed' || measure?.kind === 'monetary')) return 'number';
  }
  if (observed.number && !observed.text && !observed.boolean) {
    const unitTypes = new Set<string>();
    let allTypedMeasures = observed.dataTypes.size > 0;
    for (const dataType of observed.dataTypes) {
      const measure = measureUnit(dataType);
      if (measure?.kind === 'typed') unitTypes.add(measure.unitType);
      else if (measure?.kind === 'monetary') unitTypes.add('MONETARY');
      else allTypedMeasures = false;
    }
    const compatibleMeasures = allTypedMeasures && unitTypes.size === 1;
    if (observed.dataTypes.size > 1 && !compatibleMeasures) return 'category';
    if (observed.units.size > 1 && !compatibleMeasures) return 'category';
    return 'number';
  }
  if (observed.boolean && !observed.text && !observed.number) return 'boolean';
  return 'category';
}

function numericMetadata(kind: ObservedKind, valueKind: ElementFieldValueKind): { unit?: string; dataType?: string } {
  if (valueKind !== 'number') return {};
  return {
    ...(kind.units.size === 1 ? { unit: [...kind.units][0] } : {}),
    ...(kind.dataTypes.size > 0 ? { dataType: [...kind.dataTypes].sort()[0] } : {}),
  };
}

/** The picker's catalog: one option per field, kind inferred from the whole merged record. */
export function catalogFromObservations(observations: ElementFieldObservations): ElementFieldCatalog {
  const attributes = [...observations.attributes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([attributeName, kind]): ElementFieldOption => {
      const valueKind = inferKind(kind);
      const { dataType } = numericMetadata(kind, valueKind);
      return {
        binding: { kind: 'attribute', attributeName, valueKind, ...(dataType ? { dataType } : {}) },
        label: attributeName,
        observedValue: kind.text || kind.number || kind.boolean,
      };
    });
  const properties = new Map<string, ElementFieldOption[]>();
  for (const { psetName, propertyName, kind } of observations.properties.values()) {
    const valueKind = inferKind(kind);
    const { unit, dataType } = numericMetadata(kind, valueKind);
    const option: ElementFieldOption = {
      binding: { kind: 'property', psetName, propertyName, valueKind, ...(unit ? { unit } : {}), ...(dataType ? { dataType } : {}) },
      label: `${psetName}.${propertyName}`,
      observedValue: kind.text || kind.number || kind.boolean,
    };
    const bucket = properties.get(psetName) ?? [];
    bucket.push(option);
    properties.set(psetName, bucket);
  }
  for (const options of properties.values()) options.sort((a, b) => a.label.localeCompare(b.label));
  return { attributes, properties: new Map([...properties].sort(([a], [b]) => a.localeCompare(b))) };
}
