/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { citationsByIdentity, compareFact, declaredUnit, formatFactValue, rowIdentity, valueAt } from './report-facts';

// #6918 invariant: a claimed number matches only when it equals the captured value after converting
// between units of the same dimension the evidence itself declares. Only a string that writes out its
// decimals states a precision; a JSON number has already lost any trailing zeros.
test('numeric facts match exactly, or at the precision a decimal string states, only across declared, comparable units', () => {
  assert.equal(compareFact('2.4', 'm', 2.4349, 'm').kind, 'match', 'one decimal written: 2.4349 rounds to 2.4');
  assert.equal(compareFact('2.4', 'm', 2.46, 'm').kind, 'mismatch');
  assert.equal(compareFact(2.4, 'm', 2.4349, 'm').kind, 'mismatch', 'a JSON number states no precision');
  assert.equal(compareFact('2,40', 'm', 2.4, 'm').kind, 'match', 'decimal comma');
  assert.equal(compareFact('2,40', 'm', 2.404, 'm').kind, 'match', 'two decimals written');
  assert.equal(compareFact('2,40', 'm', 2.406, 'm').kind, 'mismatch');
  // Review of #6972: a whole number in JSON is not "rounded to metres", and -0.10 arrives as -0.1.
  assert.equal(compareFact(0, 'm', -0.02, 'm').kind, 'mismatch', '0 m is not a 20 mm overlap');
  assert.equal(compareFact(-0.1, 'm', -0.14, 'm').kind, 'mismatch', '-0.1 m is not -0.14 m');
  assert.equal(compareFact('3', undefined, 3.4, undefined).kind, 'mismatch', 'a string without decimals is exact too');
  assert.equal(compareFact(-20, 'mm', -0.02, 'm').kind, 'match', 'mm against m');
  assert.equal(compareFact(-25, 'mm', -0.02, 'm').kind, 'mismatch');
  assert.equal(compareFact(12.5, 'm²', 12.5, 'm2').kind, 'match', 'superscript spelling of the same unit');
  assert.equal(compareFact(150, 'cm2', 0.015, 'm2').kind, 'match');
  const wrongDimension = compareFact(2, 'm2', 2, 'm');
  assert.equal(wrongDimension.kind, 'mismatch');
  assert.match(wrongDimension.kind === 'mismatch' ? wrongDimension.reason : '', /not a length unit/);
  // Unknown units never pass and never contradict.
  assert.equal(compareFact(2, 'm', 2, undefined).kind, 'unverifiable', 'the evidence records no unit');
  assert.equal(compareFact(2, 'furlong', 2, 'm').kind, 'unverifiable');
  assert.equal(compareFact(7, undefined, 7, 'elements').kind, 'match', 'a unitless claim compares the captured number as stated');
  // A big captured value tolerates float noise, not a different number.
  assert.equal(compareFact(123456789, undefined, 123456789.00001, undefined).kind, 'match');
  assert.equal(compareFact(123456789, undefined, 123456790, undefined).kind, 'mismatch');
});

test('text, boolean, absent and omitted captured values', () => {
  assert.equal(compareFact('Hard', undefined, 'hard', undefined).kind, 'match');
  assert.equal(compareFact('soft', undefined, 'hard', undefined).kind, 'mismatch');
  assert.equal(compareFact(true, undefined, true, undefined).kind, 'match');
  assert.equal(compareFact(false, undefined, true, undefined).kind, 'mismatch');
  assert.equal(compareFact('3', undefined, 4, undefined).kind, 'mismatch', 'a numeric string is compared as a number');
  assert.equal(compareFact('three', undefined, 3, undefined).kind, 'mismatch', 'text cannot equal a captured number');
  assert.equal(compareFact(1, undefined, undefined, undefined).kind, 'unverifiable');
  assert.equal(compareFact(1, undefined, '[omitted: evidence limit]', undefined).kind, 'unverifiable');
  assert.equal(compareFact(1, undefined, null, undefined).kind, 'unverifiable');
  assert.equal(compareFact('x', undefined, { nested: 1 }, undefined).kind, 'unverifiable');
});

test('field paths and units are read generically from any row shape', () => {
  const row = { a: { tag: 'IfcWall' }, results: [{ actual: 3 }], value: 4.2, valueUnit: 'm', units: { area: 'm2' }, area: 9, unit: 'kg', mass: 12 };
  assert.equal(valueAt(row, 'a.tag'), 'IfcWall');
  assert.equal(valueAt(row, 'results[0].actual'), 3);
  assert.equal(valueAt(row, 'results[1].actual'), undefined);
  assert.equal(valueAt(row, 'constructor'), undefined, 'prototype members are not row fields');
  assert.equal(declaredUnit(row, null, 'value'), 'm', '<field>Unit beside the value');
  assert.equal(declaredUnit(row, null, 'area'), 'm2', 'units map on the row');
  assert.equal(declaredUnit(row, null, 'mass'), 'kg', 'row-wide unit');
  assert.equal(declaredUnit({ distance: 1 }, { units: { distance: 'm' } }, 'distance'), 'm', 'summary units');
  assert.equal(declaredUnit({ distance: 1 }, null, 'distance'), undefined);
  assert.equal(formatFactValue(undefined), 'not present');
  assert.equal(formatFactValue(-0.0200000001, 'm'), '-0.02 m');
});

test('row identity finds the same native row after renumbering and refuses ambiguity', () => {
  const rows = new Map<string, unknown>([['E1', { id: 'c2', distance: 1 }], ['E2', { id: 'c1', distance: 2 }],
    ['E3', { note: 'no id' }], ['E4', { note: 'twin' }], ['E5', { note: 'twin' }]]);
  const index = citationsByIdentity(rows);
  assert.equal(index.get(rowIdentity({ id: 'c1', distance: 99 })), 'E2', 'identity fields, not values, identify a row');
  assert.equal(index.get(rowIdentity({ note: 'no id' })), 'E3', 'identity-less rows match only identical content');
  assert.equal(index.get(rowIdentity({ note: 'twin' })), null, 'two identical rows cannot be told apart');
  assert.equal(rowIdentity({ specification: { id: 's1' }, globalId: 'g' }), 'globalId=g|specification.id=s1');
});
