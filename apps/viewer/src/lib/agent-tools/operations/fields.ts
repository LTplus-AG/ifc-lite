/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { discoverFilterSchema, discoverPropertyAndQuantitySchema, discoverFilterValues } from '@/lib/search/filter-schema';
import { operation, emptySchema } from './contract';
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const tuple = (...items: Record<string, unknown>[]) => ({ type: 'array', items, minItems: items.length, maxItems: items.length, additionalItems: false });
const meta = (id: string, description: string, outputSchema: Record<string, unknown>) => ({ id, owner: 'hierarchy', description,
  effects: ['read'] as const, capability: 'read' as const, implementation: 'native-store' as const, outputSchema });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const fieldOperations = [
  operation(meta('fields.schema', 'Discover the native effective IFC-type/storey selectors used by filter, list and chart editors. Uses the current model mutation view.', object({
    ifcTypes: strings, storeys: { type: 'array', items: tuple(string, { anyOf: [{ type: 'number' }, { type: 'null' }] }) },
  })), emptySchema, (_, c) => discoverFilterSchema(c.model.store, c.model.mutationView())),
  operation<{ ifc_types?: string[] }>(meta('fields.properties', 'Discover native property/quantity field choices, optionally scoped to IFC types. Uses the same effective property discovery as the UI.', object({
    psets: { type: 'array', items: tuple(string, strings) },
    qtos: { type: 'array', items: tuple(string, { type: 'array', items: tuple(string, string) }) },
  })), { type: 'object', properties: { ifc_types: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 100, uniqueItems: true, nullable: true } }, required: [], additionalProperties: false },
  (i, c) => discoverPropertyAndQuantitySchema(c.model.store, i.ifc_types ?? undefined, c.model.mutationView())),
  operation(meta('fields.values', 'Discover native bounded sampled material, classification, predefined-type and property-value choices. Sampling limits remain those of the native UI discovery service.', object({
    materials: strings, classificationSystems: strings, classifications: strings, predefinedTypes: strings,
    propertyValues: { type: 'object', additionalProperties: strings },
  })), emptySchema, (_, c) => {
    const result = discoverFilterValues(c.model.store, c.model.mutationView());
    return { ...result, propertyValues: Object.fromEntries(result.propertyValues) };
  }),
];
