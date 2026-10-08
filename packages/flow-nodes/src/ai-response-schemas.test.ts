/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7132: actual JSON Schema compilation and rejection, not prompt-text assertions. */
import { Ajv } from 'ajv';
import { expect, it } from 'vitest';
import { classificationSchema, extractionSchema, proposalSchema, summarySchema } from './ai-response-schemas.js';
import { proposalFields } from './ai-propose-fields.js';

const ajv = new Ajv({ strict: true, allowUnionTypes: true });

it('constrains row labels and evidence to the selected batch and columns', () => {
  const check = ajv.compile(classificationSchema(['a', 'b'], ['wall'], ['Name']).schema);
  expect(check({ items: [{ key: 'a', label: 'wall', evidence: ['Name'] }] })).toBe(true);
  expect(check({ items: [{ key: 'a', label: 'unknown', evidence: [] }] })).toBe(true);
  for (const item of [
    { key: 'unsent', label: 'wall', evidence: ['Name'] },
    { key: 'a', label: 'invented', evidence: ['Name'] },
    { key: 'a', label: 'wall', evidence: ['Private'] },
    { key: 'a', label: 'wall', evidence: ['Name'], extra: 'invented' },
  ]) expect(check({ items: [item] })).toBe(false);
});

it('requires every selected typed extraction field, permitting explicit unknown values', () => {
  const check = ajv.compile(extractionSchema([3], [{ name: 'Height', type: 'number' }, { name: 'FireRated', type: 'boolean' }]).schema);
  const record = { passage: 3, span: 'height 3m', values: { Height: 3, FireRated: null } };
  expect(check({ records: [record] })).toBe(true);
  expect(check({ records: [{ ...record, passage: 4 }] })).toBe(false);
  expect(check({ records: [{ ...record, values: { Height: '3', FireRated: false } }] })).toBe(false);
  expect(check({ records: [{ ...record, values: { Height: 3 } }] })).toBe(false);
  expect(check({ records: [{ ...record, values: { ...record.values, Unselected: true } }] })).toBe(false);
});

it('requires structured narrative sections with captured citation keys', () => {
  const check = ajv.compile(summarySchema(['wall-1']).schema);
  expect(check({ sections: [{ heading: 'Review', text: 'Inspect the wall', citations: ['wall-1'] }] })).toBe(true);
  expect(check({ sections: [{ heading: 'Review', text: 'Invented', citations: ['unknown'] }] })).toBe(false);
  expect(check({ sections: [{ heading: 'Review', citations: ['wall-1'] }] })).toBe(false);
});

it('expresses a native change artifact and a clarification without a root union or JSON string', () => {
  const fields = proposalFields([{ op: 'attribute.set', name: 'Name', expectedColumn: 'Name', allowedValues: ['Reviewed'] }], ['Name']);
  const check = ajv.compile(proposalSchema(fields, ['row-1'], true).schema);
  const change = { op: 'attribute.set', target: { globalId: '0000000000000000000001', modelId: 'model-a' },
    name: 'Name', expected: 'Old', value: 'Reviewed' };
  const reply = { artifact: { version: 1, kind: 'model.changes', title: 'Rename', changes: [change] }, citations: ['row-1'], clarification: null };
  expect(check(reply)).toBe(true);
  expect(check({ artifact: null, citations: [], clarification: 'Which model?' })).toBe(true);
  expect(check({ ...reply, artifact: JSON.stringify(reply.artifact) })).toBe(false);
  expect(check({ ...reply, artifact: { ...reply.artifact, changes: [{ ...change, name: 'GlobalId' }] } })).toBe(false);
  expect(check({ ...reply, artifact: { ...reply.artifact, changes: [{ ...change, target: { globalId: 'bad' } }] } })).toBe(false);
});

it('keeps large source inventories usable without exceeding provider enum limits', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `row-${i}`);
  const check = ajv.compile(summarySchema(keys).schema);
  expect(check({ sections: [{ heading: 'Review', text: 'Evidence still requires native membership validation', citations: ['row-1999'] }] })).toBe(true);
});
