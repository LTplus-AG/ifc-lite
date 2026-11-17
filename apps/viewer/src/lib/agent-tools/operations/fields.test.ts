/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedPropertyValues } from './fields';

test('fields.values keeps property keys only while they fit the result budget', () => {
  const many = Array.from({ length: 100 }, (_, i): [string, string[]] => [`Pset.Key${i}`, Array.from({ length: 200 }, (_, j) => `${'v'.repeat(60)}${j}`)]);
  const bounded = boundedPropertyValues(many, 900_000);
  assert.ok(JSON.stringify(bounded).length <= 900_000);
  assert.ok(Object.keys(bounded).length > 0 && Object.keys(bounded).length < 100);
  assert.deepEqual(boundedPropertyValues([['a', ['x']]], 1000), { a: ['x'] });
});
