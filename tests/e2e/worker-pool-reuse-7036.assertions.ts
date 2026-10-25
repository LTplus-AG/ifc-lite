/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PoolReuseReport } from './worker-pool-reuse-7036.wasm.js';

// The actual report contains only plain objects, arrays and primitive values.
// Like Playwright toEqual, undefined properties/array slots do not distinguish
// otherwise equal values. Compare all enumerable keys, including future fields.
function equalReportValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<PropertyKey, unknown>;
  const b = right as Record<PropertyKey, unknown>;
  const keys = (value: Record<PropertyKey, unknown>) => Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key) && value[key] !== undefined);
  const aKeys = keys(a), bKeys = new Set(keys(b));
  return aKeys.length === bKeys.size && aKeys.every(key => bKeys.has(key) && equalReportValue(a[key], b[key]));
}
function requireInvariant(condition: boolean, name: string): void {
  if (!condition) throw new Error(`#7036 Worker witness invariant failed: ${name}`);
}

/** The original two-case witness assertions, shared by Playwright and native preview. */
export function assertPoolReuseReport(report: PoolReuseReport): void {
  requireInvariant(report.outputs.first.meshes > 0, 'first meshes > 0');
  requireInvariant(equalReportValue(report.outputs.repeat, report.outputs.first), 'repeat equals first');
  requireInvariant(Object.is(report.spawnedAfterRepeat, report.spawnedBeforeRepeat), 'repeat creates no workers');
  requireInvariant(equalReportValue(report.outputs.federated, report.outputs.federatedFresh), 'federated equals fresh');
  requireInvariant(report.outputs.federated.geometryHashes > 0, 'federated geometry hashes > 0');
  requireInvariant(equalReportValue(report.outputs.restored, report.outputs.restoredFresh), 'restored equals fresh');
  requireInvariant(Object.is(report.outputs.restored.geometryHashes, 0), 'restored geometry hashes = 0');
  requireInvariant(Object.is(report.outputs.restored.digest, report.outputs.first.digest), 'restored digest equals first');
  requireInvariant(!Object.is(report.outputs.federated.digest, report.outputs.first.digest), 'federated digest differs from first');
  requireInvariant(Object.is(report.bootWorkerCreations, 2), 'boot creates two workers');
  requireInvariant(Object.is(report.bootAdmittedWorkers, 2), 'boot admits two workers');
  requireInvariant(Object.is(report.bootWarmingWorkers, 0), 'boot warming workers = 0');
  requireInvariant(report.initialWorkerHeapBytes.length === 2, 'two initial worker heaps');
  for (const heap of report.initialWorkerHeapBytes) {
    requireInvariant(heap > 0, 'initial heap > 0');
    requireInvariant(heap <= 9 * 1024 * 1024, 'initial heap <= 9 MiB');
  }
  requireInvariant(Object.is(report.parserHandoffDigest, report.parserScanDigest), 'parser handoff equals independent scan');
  requireInvariant(report.finalIdleBytes <= 144 * 1024 * 1024, 'idle retention <= 144 MiB');
  requireInvariant(Object.is(report.federationIdsDistinct, true), 'federation IDs distinct');
}

export function assertHiddenBootAdmission(stats: { idle: number; spawned: number }): void {
  requireInvariant(Object.is(stats.idle, 0), 'hidden idle = 0');
  requireInvariant(Object.is(stats.spawned, 0), 'hidden spawned = 0');
}
