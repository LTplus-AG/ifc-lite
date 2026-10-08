/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from './schema-subset.mjs';

const schema = { type: 'object', required: ['id'], additionalProperties: false, properties: {
  id: { type: 'string', pattern: '^[a-z]+$' }, n: { type: 'integer', minimum: 1, maximum: 3 }, tags: { type: 'array', minItems: 1, items: { enum: ['a', 'b'] } },
  kind: { oneOf: [{ type: 'null' }, { type: 'object', required: ['k'], properties: { k: { const: 1 } } }] } } };

test('valid documents pass', () => {
  assert.deepEqual(validateSchema(schema, { id: 'abc', n: 2, tags: ['a'], kind: null }), []);
  assert.deepEqual(validateSchema(schema, { id: 'abc', kind: { k: 1 } }), []);
});

test('each violated keyword is reported with its path', () => {
  const errors = validateSchema(schema, { id: 'ABC', n: 9, tags: [], extra: 1, kind: { k: 2 } });
  for (const part of ['$.id', '$.n', '$.tags', 'unexpected property "extra"', '$.kind']) assert.ok(errors.some(error => error.includes(part)), `${part} in ${errors}`);
  assert.ok(validateSchema(schema, {}).some(error => error.includes('id')), 'missing required property');
  assert.ok(validateSchema(schema, { id: 'a', n: 1.5 }).some(error => error.includes('$.n')), 'non-integer');
});

test('an unsupported keyword is refused, never silently ignored', () => {
  assert.throws(() => validateSchema({ type: 'string', format: 'email' }, 'a@b.c'), /format/);
});
