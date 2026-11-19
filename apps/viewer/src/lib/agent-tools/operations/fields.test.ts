/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedFieldValues, boundedPropertyValues } from './fields';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test('fields.values keeps property keys only while they fit the result budget', () => {
  const many = Array.from({ length: 100 }, (_, i): [string, string[]] => [`Pset.Key${i}`, Array.from({ length: 200 }, (_, j) => `${'v'.repeat(60)}${j}`)]);
  const bounded = boundedPropertyValues(many, 900_000);
  assert.ok(bytes(bounded) <= 900_000);
  assert.ok(Object.keys(bounded).length > 0 && Object.keys(bounded).length < 100);
  const all = Object.fromEntries(many.slice(0, 3));
  assert.deepEqual(boundedPropertyValues(many.slice(0, 3), bytes(all)), all, 'a budget of exactly the full size keeps every key');
});

test('fields.values shares one byte budget across all five fields and names the cut ones (#10598)', () => {
  const long = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}${'é'.repeat(100)}`);
  const values = { materials: ['Brick', 'Concrete'], classificationSystems: long('System', 5000), classifications: long('Code', 5000),
    predefinedTypes: ['STANDARD'], propertyValues: new Map([['Pset_WallCommon.FireRating', ['EI60', 'EI90']]]) };
  const budget = 400_000;
  const bounded = boundedFieldValues(values, budget);
  assert.ok(bytes(bounded) <= budget, `${bytes(bounded)} bytes exceeds ${budget}`);
  assert.deepEqual(bounded.truncated, ['classificationSystems', 'classifications']);
  // Small fields stay whole; the two large ones split the rest evenly.
  assert.deepEqual(bounded.materials, values.materials);
  assert.deepEqual(bounded.predefinedTypes, values.predefinedTypes);
  assert.deepEqual(bounded.propertyValues, Object.fromEntries(values.propertyValues));
  // Each cut field leaves less than one item unused, so the result nearly fills the budget.
  assert.ok(bytes(bounded) > budget - 2 * bytes(values.classificationSystems[0]) - 200, `${bytes(bounded)} bytes leaves budget unused`);
  assert.deepEqual(bounded.classifications, values.classifications.slice(0, bounded.classifications.length), 'a cut list keeps its sorted prefix');
  const whole = boundedFieldValues(values, Number.MAX_SAFE_INTEGER);
  assert.equal(whole.truncated, undefined);
  assert.equal(whole.classifications.length, 5000);
});

test('a cut field passes the share it cannot use to the next cut field (#10598)', () => {
  // One property key far larger than any share: propertyValues keeps nothing, and its share goes to classifications.
  const values = { materials: [], classificationSystems: [], classifications: Array.from({ length: 5000 }, (_, i) => `Code${String(i).padStart(5, '0')}${'x'.repeat(200)}`),
    predefinedTypes: [], propertyValues: new Map([['Pset.Huge', ['y'.repeat(300_000)]]]) };
  const bounded = boundedFieldValues(values, 200_000);
  assert.deepEqual(bounded.truncated, ['classifications', 'propertyValues']);
  assert.deepEqual(bounded.propertyValues, {});
  assert.ok(bytes(bounded.classifications) > 190_000, `${bytes(bounded.classifications)} bytes of classifications`);
});
