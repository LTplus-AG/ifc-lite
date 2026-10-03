/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, refs, requirePair, requireDiagnostics, poolCensus } from './sdk-plan.mjs';

const diagnostics = { schemaVersion: 3, totalCsgFailures: 3,
  failuresByReason: [{ reason: 'KernelError', count: 2 }, { reason: 'NoBoundsOverlap', count: 1 }],
  failuresByProduct: [{ expressId: 42, count: 2 }, { expressId: 7, count: 1 }] };
function row(arm, elapsedMs = 100, kind = 'AB') {
  return { family: 'house', pair: 2, kind, arm, status: 'complete', workerCount: 2, workerIds: [0, 1],
    runtime: { hardwareConcurrency: 4, deviceMemory: 8, sab: true, crossOriginIsolated: true, browserVersion: '153', overrides: [] },
    receipt: { status: 'supported-output', generatorDone: true, processorDisposed: true, elapsedMs,
      identity: { sha256: 'a'.repeat(64), flat: 2, occurrences: 3, triangles: 8 },
      complete: { diagnostics: structuredClone(diagnostics) } } };
}
test('#6537 schedule contains two AA controls then five alternating AB pairs for each exact family', () => {
  const plan = schedule(); assert.equal(plan.length, 56); assert.equal(new Set(plan.map(item => item.id)).size, 56);
  for (let start = 0; start < 56; start += 14) {
    const family = plan.slice(start, start + 14);
    assert.equal(new Set(family.map(item => item.family)).size, 1);
    assert.deepEqual(family.map(item => item.arm), ['base', 'base', 'base', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate']);
    assert.deepEqual(family.filter((_item, index) => index % 2 === 0).map(item => item.kind), ['AA', 'AA', 'AB', 'AB', 'AB', 'AB', 'AB']);
    assert.ok(family.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0 && item.timeoutMs >= 180000));
  }
});
test('#6537 immutable refs refuse incomplete, shell-bearing, uppercase and same-arm inputs', () => {
  assert.deepEqual(refs('a'.repeat(40), 'b'.repeat(40)), { base: 'a'.repeat(40), candidate: 'b'.repeat(40) });
  for (const input of ['', 'main', 'A'.repeat(40), 'a'.repeat(40) + ';echo unsafe']) assert.throws(() => refs(input, 'b'.repeat(40)));
  assert.throws(() => refs('a'.repeat(40), 'a'.repeat(40)));
});
test('#6537 default two-worker census accepts publication order but refuses holes, duplicates and inferred counts', () => {
  assert.deepEqual(poolCensus(2, [{ workerIndex: 1 }, { workerIndex: 0 }]), [0, 1]);
  for (const [count, ids] of [[2, [0, 0]], [2, [0, 2]], [3, [0, 1]], [1, [0]], [2, [0, '1']]]) {
    assert.throws(() => poolCensus(count, ids.map(workerIndex => ({ workerIndex }))));
  }
});
test('#6537 AB delta respects the actual alternating arm order and full-family baseline witness', () => {
  const base = row('base', 100), candidate = row('candidate', 80);
  assert.ok(Math.abs(requirePair(base, candidate, row('base')).relativeDelta + 0.2) < 1e-12);
  assert.deepEqual(requirePair(candidate, base, row('base')).milliseconds, [80, 100]);
});
test('#6537 A/A noise, incomplete drains and invalid elapsed values are terminal', () => {
  assert.equal(requirePair(row('base', 100, 'AA'), row('base', 109, 'AA')).relativeDelta, null);
  assert.throws(() => requirePair(row('base', 100, 'AA'), row('base', 111, 'AA')), /noise/);
  for (const change of [item => { item.receipt.generatorDone = false; }, item => { item.receipt.processorDisposed = false; },
    item => { item.receipt.elapsedMs = null; }, item => { item.receipt.elapsedMs = 0; }, item => { item.status = 'refused'; }]) {
    const candidate = row('candidate'); change(candidate); assert.throws(() => requirePair(row('base'), candidate));
  }
});
test('#6537 exact CPU identity and raw diagnostic order/attribution must match without normalization', () => {
  for (const change of [item => { item.receipt.identity.triangles++; }, item => { item.receipt.identity.sha256 = 'b'.repeat(64); },
    item => { item.receipt.complete.diagnostics.failuresByReason.reverse(); },
    item => { item.receipt.complete.diagnostics.failuresByProduct.reverse(); },
    item => { item.receipt.complete.diagnostics.failuresByProduct[0].expressId++; }]) {
    const candidate = row('candidate'); change(candidate); assert.throws(() => requirePair(row('base'), candidate));
  }
});
test('#6537 actual hardware and worker configuration, fixed arms and prior-family witness cannot drift', () => {
  for (const change of [item => { item.runtime.deviceMemory = 4; }, item => { item.workerCount = 3; },
    item => { item.workerIds = [0, 2]; }, item => { item.family = 'csg'; }, item => { item.arm = 'base'; }]) {
    const candidate = row('candidate'); change(candidate); assert.throws(() => requirePair(row('base'), candidate));
  }
  const witness = row('base'); witness.receipt.identity.flat++; assert.throws(() => requirePair(row('base'), row('candidate'), witness));
});
test('#6537 canonical diagnostics refuse unknown reasons, fractional counts and inconsistent totals', () => {
  requireDiagnostics(diagnostics);
  for (const change of [value => { value.schemaVersion = 2; }, value => { value.failuresByReason[0].reason = 'WorkerPanic'; },
    value => { value.failuresByReason[0].count = 1.5; }, value => { value.totalCsgFailures++; }]) {
    const value = structuredClone(diagnostics); change(value); assert.throws(() => requireDiagnostics(value));
  }
});
