/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, growth, checkTargets, OPERATIONS } from './modelling-session.mjs';

// #9296: censored runs must never certify round-1 scale targets.
test('nearest-rank quantiles include slow tail and preserve input', () => {
  const values = [100, 1, 3, 2, 4];
  assert.deepEqual(summarize(values), { count: 5, p50: 3, p95: 100 });
  assert.deepEqual(values, [100, 1, 3, 2, 4]);
});
const targets = { targets: { maxGrowthExclusive: 2, f5MsExclusive: 60000 } };
const complete = () => [1000, 10000, 50000].map(target => ({ status: 'pass', metrics: { target, operations: Object.fromEntries(OPERATIONS.map(op => [op, { p50: target === 1000 ? 10 : 19, p95: target === 1000 ? 20 : 39 }])) } }));
test('censored size yields no growth and fails target coverage', () => {
  const results = complete();
  results[2].status = 'fail';
  assert.equal(growth(results, 'addColumn', 'p50', 1000, 50000), null);
  assert.ok(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000 } }).some(f => f.includes('50000')));
});
test('strict growth and F5 limits; a missing F5 cannot pass', () => {
  const results = complete();
  assert.deepEqual(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000 } }), []);
  assert.equal(checkTargets(results, targets).length, 1);
  assert.equal(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 60000 } }).length, 1);
  results[2].metrics.operations.addColumn.p95 = 40;
  assert.ok(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000 } }).some(f => f.includes('addColumn p95')));
});
