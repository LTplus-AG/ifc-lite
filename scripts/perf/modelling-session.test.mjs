/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
let summarize, growth, checkTargets, OPERATIONS;
async function loadScripts() {
  assert.ok(existsSync(new URL('./modelling-session.mjs',import.meta.url)), 'perf script must exist');
  assert.ok(existsSync(new URL('./modelling-session-worker.mjs',import.meta.url)), 'perf worker must exist');
  ({summarize,growth,checkTargets,OPERATIONS}=await import('./modelling-session.mjs'));
}

// #9296: censored runs must never certify round-1 scale targets.
test('nearest-rank quantiles include slow tail and preserve input', async () => {
  await loadScripts();
  const values = [100, 1, 3, 2, 4];
  assert.deepEqual(summarize(values), { count: 5, p50: 3, p95: 100 });
  assert.deepEqual(values, [100, 1, 3, 2, 4]);
});
const targets = { targets: { maxGrowthExclusive: 2, f5MsExclusive: 60000 } };
const complete = () => [1000, 10000, 50000].map(target => ({ status: 'pass', metrics: { target, reached:target, operations: Object.fromEntries(OPERATIONS.map(op => [op, { count:5, p50: target === 1000 ? 10 : 19, p95: target === 1000 ? 20 : 39 }])) } }));
test('censored size yields no growth and fails target coverage', async () => {
  await loadScripts();
  const results = complete();
  results[2].status = 'fail';
  assert.equal(growth(results, 'addColumn', 'p50', 1000, 50000), null);
  assert.ok(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000, elements:1600, peakHeap:100, completedSteps:20, totalSteps:20 } }).some(f => f.includes('50000')));
});
test('strict growth and F5 limits; a missing F5 cannot pass', async () => {
  await loadScripts();
  const results = complete();
  assert.deepEqual(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000, elements:1600, peakHeap:100, completedSteps:20, totalSteps:20 } }), []);
  assert.equal(checkTargets(results, targets).length, 1);
  assert.equal(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 60000, elements:1600, peakHeap:100, completedSteps:20, totalSteps:20 } }).length, 1);
  results[2].metrics.operations.addColumn.p95 = 40;
  assert.ok(checkTargets(results, targets, { probe: 'exercise', id: 'F5', status: 'pass', metrics: { ms: 59000, elements:1600, peakHeap:100, completedSteps:20, totalSteps:20 } }).some(f => f.includes('addColumn p95')));
});

const f5=()=>({probe:'exercise',id:'F5.summary',status:'pass',metrics:{ms:59000,elements:1600,peakHeap:100,completedSteps:20,totalSteps:20}});
test('#9318 check refuses incomplete reached counts for every size',async ()=>{
  await loadScripts();
  for(let i=0;i<3;i++) for(const reached of [undefined,0]) { const rows=complete();rows[i].metrics.reached=reached;assert.ok(checkTargets(rows,targets,f5()).some(f=>f.includes(String(rows[i].metrics.target)))); }
});
test('#9318 check refuses fewer than five samples for every operation',async ()=>{
  await loadScripts();
  for(let i=0;i<3;i++) for(const op of OPERATIONS) for(const count of [undefined,0,4]) {const rows=complete();rows[i].metrics.operations[op].count=count;assert.ok(checkTargets(rows,targets,f5()).some(f=>f.includes(op)));}
});
test('#9318 check refuses missing F5 result fields',async ()=>{
  await loadScripts();
  for(const key of ['ms','elements','peakHeap','completedSteps','totalSteps']) { const result=f5();delete result.metrics[key];assert.ok(checkTargets(complete(),targets,result).some(f=>f.includes('F5'))); }
});


test('#9318 empty F5 exercises cannot certify the round-1 target', async () => {
  await loadScripts();
  const result = f5();
  result.metrics.completedSteps = 0;
  result.metrics.totalSteps = 0;
  assert.ok(checkTargets(complete(), targets, result).some(f => f.includes('F5')));
});
