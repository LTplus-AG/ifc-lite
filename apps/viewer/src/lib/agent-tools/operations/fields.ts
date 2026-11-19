/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { discoverFilterSchema, discoverPropertyAndQuantitySchema, discoverFilterValues, type FilterValueSchema } from '@/lib/search/filter-schema';
import { operation, emptySchema } from './contract';
import { MAX_RESULT_BYTES } from './result-limit';
const string = { type: 'string' };
const utf8 = new TextEncoder();
/** Measured as the executor measures a result: UTF-8 bytes of its JSON. */
const bytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length;
const strings = { type: 'array', items: string };
const tuple = (...items: Record<string, unknown>[]) => ({ type: 'array', items, minItems: items.length, maxItems: items.length, additionalItems: false });
const meta = (id: string, description: string, outputSchema: Record<string, unknown>) => ({ id, owner: 'hierarchy', description,
  effects: ['read'] as const, capability: 'read' as const, implementation: 'native-store' as const, outputSchema });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
/**
 * The sampler bounds values per key but not the number of keys; keep the keys whose JSON object fits `budget` bytes.
 * Each entry costs `"key":[...]` plus one separator, so a budget equal to the full object's size keeps every key.
 */
export function boundedPropertyValues(values: Iterable<[string, string[]]>, budget: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let used = 1;
  for (const [key, list] of values) {
    const size = bytes(key) + bytes(list) + 2;
    if (used + size > budget) continue; // a later, smaller key may still fit
    out[key] = list; used += size;
  }
  return out;
}
/** Keeps the sorted prefix of `values` whose JSON array fits `budget` bytes. */
function boundedList(values: string[], budget: number): string[] {
  let used = 1, count = 0;
  for (; count < values.length; count++) {
    used += bytes(values[count]) + 1;
    if (used > budget) break;
  }
  return values.slice(0, count);
}
const valueLists = { materials: strings, classificationSystems: strings, classifications: strings, predefinedTypes: strings,
  propertyValues: { type: 'object', additionalProperties: strings } };
type ValueField = keyof typeof valueLists;
const VALUE_FIELDS = Object.keys(valueLists) as ValueField[];
type FieldValues = Omit<FilterValueSchema, 'propertyValues'> & { propertyValues: Record<string, string[]>; truncated?: ValueField[] };
/**
 * One byte budget across all five fields (#10598): the returned object, keys and `truncated` included, fits `budget`.
 * Fields are filled smallest first, each up to an equal share of what is left, so a small field keeps all of it and
 * no field can starve the others. A cut field charges only the bytes it kept; the rest flows to the larger fields.
 */
export function boundedFieldValues(values: FilterValueSchema, budget: number): FieldValues {
  // Keys in ordinal order (they hold propValueKey's NUL separator), so neither output order nor which keys survive a cut
  // depends on entity order.
  const keys = [...values.propertyValues].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: FieldValues = { ...values, propertyValues: Object.fromEntries(keys) };
  // Reserve keys and a full `truncated` list; the null placeholders and each field's own brackets are slack.
  let left = budget - bytes({ ...Object.fromEntries(VALUE_FIELDS.map(field => [field, null])), truncated: VALUE_FIELDS });
  const bySize = VALUE_FIELDS.map(field => ({ field, size: bytes(out[field]) })).sort((a, b) => a.size - b.size);
  const truncated = new Set<ValueField>();
  bySize.forEach(({ field, size }, index) => {
    const share = Math.floor(left / (bySize.length - index));
    if (size <= share) { left -= size; return; }
    truncated.add(field);
    if (field === 'propertyValues') out.propertyValues = boundedPropertyValues(keys, share);
    else out[field] = boundedList(out[field], share);
    left -= bytes(out[field]);
  });
  return truncated.size ? { ...out, truncated: VALUE_FIELDS.filter(field => truncated.has(field)) } : out;
}
export const fieldOperations = [
  operation(meta('fields.schema', 'Discover the native effective IFC-type/storey selectors used by filter, list and chart editors. Uses the current model mutation view.', object({
    ifcTypes: strings, storeys: { type: 'array', items: tuple(string, { anyOf: [{ type: 'number' }, { type: 'null' }] }) },
  })), emptySchema, (_, c) => discoverFilterSchema(c.model.store, c.model.mutationView())),
  operation<{ ifc_types?: string[] }>(meta('fields.properties', 'Discover native property/quantity field choices, optionally scoped to IFC types. Uses the same effective property discovery as the UI.', object({
    psets: { type: 'array', items: tuple(string, strings) },
    qtos: { type: 'array', items: tuple(string, { type: 'array', items: tuple(string, string) }) },
  })), { type: 'object', properties: { ifc_types: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 100, uniqueItems: true, nullable: true } }, required: [], additionalProperties: false },
  (i, c) => discoverPropertyAndQuantitySchema(c.model.store, i.ifc_types ?? undefined, c.model.mutationView())),
  operation(meta('fields.values', 'Discover native bounded sampled material, classification, predefined-type and property-value choices. Sampling limits remain those of the native UI discovery service. The five fields share the result size limit; a field cut to fit is named in truncated.', {
    ...object(valueLists), properties: { ...valueLists, truncated: { type: 'array', items: { type: 'string', enum: VALUE_FIELDS }, minItems: 1, uniqueItems: true } },
  }), emptySchema, (_, c) => boundedFieldValues(discoverFilterValues(c.model.store, c.model.mutationView()), MAX_RESULT_BYTES)),
];
