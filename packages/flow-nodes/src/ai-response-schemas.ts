/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Native Flow JSON shapes, shared by every provider and host (#7132). */
import type { JsonResponseSchema } from '@ifc-lite/ai';
import type { ProposalField } from './ai-propose-fields.js';

type Schema = Record<string, unknown>;
const string: Schema = { type: 'string' };
const array = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
// Citation/source inventories can exceed provider enum limits. Native readers
// always validate membership; a large inventory keeps the same string contract.
const names = (values: readonly string[]): Schema => values.length && values.length <= 100 && values.reduce((sum, value) => sum + value.length, 0) <= 10_000
  ? { type: 'string', enum: [...new Set(values)] } : string;
const contract = (name: string, schema: Schema): JsonResponseSchema => ({ name, schema });

export function classificationSchema(keys: readonly string[], labels: readonly string[], columns: readonly string[]): JsonResponseSchema {
  return contract('flow_classification', object({ items: array(object({
    key: names(keys), label: names([...labels, 'unknown']), evidence: array(names(columns)),
  })) }));
}

export function extractionSchema(passages: readonly number[], fields: readonly { name: string; type: string }[]): JsonResponseSchema {
  const values = Object.fromEntries(fields.map(field => [field.name, { type: [field.type, 'null'] }]));
  return contract('flow_extraction', object({ records: array(object({
    passage: { type: 'integer', enum: [...passages] }, span: string, values: object(values),
  })) }));
}

export function summarySchema(keys: readonly string[]): JsonResponseSchema {
  return contract('flow_summary', object({ sections: array(object({
    heading: string, text: string, citations: array(names(keys)),
  })) }));
}

export function proposalSchema(fields: readonly ProposalField[], keys: readonly string[], withModel: boolean): JsonResponseSchema {
  const target = object({ globalId: { type: 'string', pattern: '^[0-9A-Za-z_$]{22}$' }, ...(withModel ? { modelId: string } : {}) });
  const changes = fields.map(({ native }) => {
    const binding = Object.fromEntries(Object.entries(native)
      .filter(([key, value]) => key !== 'target' && key !== 'expected' && key !== 'value' && value !== undefined)
      .map(([key, value]) => [key, { type: typeof value, enum: [value] }]));
    return object({ ...binding, target, expected: { type: ['string', 'number', 'boolean', 'null'] },
      ...(native.op !== 'property.delete' ? { value: { type: ['string', 'number', 'boolean', 'null'] } } : {}) });
  });
  // Allowed values remain a native semantic constraint: repeating them in
  // every branch can exceed the provider's global 1,000-enum-value limit.
  const artifact = object({ version: { type: 'integer', enum: [1] }, kind: { type: 'string', enum: ['model.changes'] },
    title: string, changes: array({ anyOf: changes }) });
  return contract('flow_proposal', object({ artifact: { anyOf: [artifact, { type: 'null' }] },
    citations: array(names(keys)), clarification: { type: ['string', 'null'] } }));
}
