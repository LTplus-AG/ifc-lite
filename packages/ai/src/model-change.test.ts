/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7081: native field identities cannot be confused by file-supplied labels. */
import { expect, it } from 'vitest';
import { parseModelChangeBatch, changeKey, type ModelChange } from './artifacts.js';
const target = { globalId: '0000000000000000000001' };
const change = (pset: string, name: string): ModelChange => ({ op: 'property.set', target, pset, name, expected: null, value: true });
const batch = (changes: ModelChange[]) => parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: 'Native identities', changes }));

it('accepts distinct native property and quantity names containing identity delimiters', () => {
  const properties = [change('A:B', 'C'), change('A', 'B:C')];
  expect(batch(properties).changes).toHaveLength(2);
  expect(new Set(properties.map(changeKey)).size).toBe(2);
  const quantities: ModelChange[] = [
    { op: 'quantity.set', target, qset: 'A:B', name: 'C', expected: 1, value: 2 },
    { op: 'quantity.set', target, qset: 'A', name: 'B:C', expected: 1, value: 2 },
  ];
  expect(batch(quantities).changes).toHaveLength(2);
  expect(new Set(quantities.map(changeKey)).size).toBe(2);
});

it('keeps an omitted model scope distinct from a literal native model id', () => {
  const base = change('P', 'X');
  const scoped = { ...base, target: { ...target, modelId: '*' } };
  expect(batch([base, scoped]).changes).toHaveLength(2);
  expect(changeKey(base)).not.toBe(changeKey(scoped));
});

it('still refuses two operations addressing the same native property value', () => {
  expect(() => batch([change('A:B', 'C'), { op: 'property.delete', target, pset: 'A:B', name: 'C', expected: true }])).toThrow(/each value only once/);
});
