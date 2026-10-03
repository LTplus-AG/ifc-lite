/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isDeepStrictEqual } from 'node:util';
import { fixtures } from './sdk-client/contracts.ts';
import { immutableRef } from './interleaved-plan.mjs';
import { canonicalReasons } from './sdk-semantic-warnings.mjs';
export { fixtures };
export const limits = Object.freeze({ initialBytes: 8 * 1024 ** 3, liveBytes: 4 * 1024 ** 3,
  rssBytes: 5 * 1024 ** 3, cleanupMs: 30000, drainMs: 3000, cohortMs: 90 * 60000,
  records: 250000, recordBytes: 64 * 1024 ** 2 });
export function refs(base, candidate) {
  const result = { base: immutableRef(base), candidate: immutableRef(candidate) };
  if (result.base === result.candidate) throw new Error('distinct immutable arms required');
  return result;
}
export function schedule() {
  return Object.entries(fixtures).flatMap(([family, fixture]) => Array.from({ length: 7 }, (_, pair) => {
    const order = pair < 2 ? ['base', 'base'] : pair % 2 ? ['candidate', 'base'] : ['base', 'candidate'];
    return order.map((arm, slot) => ({ family, pair, kind: pair < 2 ? 'AA' : 'AB', arm,
      id: `${family}-${pair}-${slot}-${arm}`, ...fixture }));
  }).flat());
}
export function requireDiagnostics(value) {
  if (!value || value.schemaVersion !== 3 || !Array.isArray(value.failuresByReason)
    || !Number.isSafeInteger(value.totalCsgFailures) || value.totalCsgFailures < 0
    || value.failuresByReason.some(item => !canonicalReasons.has(item.reason) || !Number.isSafeInteger(item.count) || item.count < 1)
    || value.failuresByReason.reduce((sum, item) => sum + item.count, 0) !== value.totalCsgFailures) throw new Error('canonical complete diagnostic schema/reason/count refused');
}
export function poolCensus(count, memory) {
  const ids = memory.map(item => item.workerIndex).sort((a, b) => a - b);
  if (!Number.isSafeInteger(count) || count < 2 || ids.length !== count
    || ids.some((id, index) => id !== index)) throw new Error('actual pool-start/memory census mismatch');
  return ids;
}
export function requirePair(left, right, witness) {
  if (left.family !== right.family || left.pair !== right.pair || left.kind !== right.kind
    || (witness && witness.family !== left.family)
    || (left.kind === 'AA' ? left.arm !== 'base' || right.arm !== 'base'
      : left.kind !== 'AB' || new Set([left.arm, right.arm]).size !== 2 || ![left.arm, right.arm].every(arm => ['base', 'candidate'].includes(arm)))) {
    throw new Error('fixed family/pair/arm contract refused');
  }
  for (const row of [left, right, ...(witness ? [witness] : [])]) {
    if (row.status !== 'complete' || row.receipt?.status !== 'supported-output'
      || !/^[a-f0-9]{64}$/.test(row.receipt.identity?.sha256 ?? '')
      || !row.receipt.generatorDone || !row.receipt.processorDisposed) throw new Error('complete produced CPU row required');
    requireDiagnostics(row.receipt.complete?.diagnostics);
  }
  for (const other of [right, ...(witness ? [witness] : [])]) {
    if (!isDeepStrictEqual(left.receipt.identity, other.receipt.identity)) throw new Error('produced CPU identity differs');
    if (!isDeepStrictEqual(left.receipt.complete.diagnostics, other.receipt.complete.diagnostics)) throw new Error('unnormalized complete diagnostics differ');
    if (!isDeepStrictEqual(left.runtime, other.runtime) || left.workerCount !== other.workerCount
      || !isDeepStrictEqual(left.workerIds, other.workerIds)) throw new Error('default runtime/worker configuration differs');
  }
  const values = [left, right].map(row => row.receipt.elapsedMs);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('finite positive timing required');
  if (left.kind === 'AA' && Math.abs(values[1] / values[0] - 1) > 0.10) throw new Error('A/A noise >10%; terminal refusal');
  const base = left.arm === 'base' ? left : right, candidate = left.arm === 'candidate' ? left : right;
  return { kind: left.kind, milliseconds: values, relativeDelta: left.kind === 'AB' ? candidate.receipt.elapsedMs / base.receipt.elapsedMs - 1 : null };
}
