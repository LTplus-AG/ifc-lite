/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isDeepStrictEqual } from 'node:util';
import { PROFILES, requireOwnedChrome, canSignalOwnedGroup } from './gpu-control.mjs';
export const SYMBOLIC_CHILD_INPUTS = Object.freeze([
  'scripts/perf/symbolic-upload-recorder.mjs', 'scripts/perf/symbolic-upload-gpu-page.mjs',
  'scripts/perf/symbolic-upload-gpu-control.mjs', 'scripts/perf/symbolic-upload-qualification.mjs',
  'scripts/perf/interleaved-cleanup.mjs',
  'scripts/perf/gpu-control.mjs', 'package.json', 'pnpm-lock.yaml',
]);
export const SYMBOLIC_ABI = Object.freeze([
  ['symbolic-fill-vbuf', 28, 40], ['symbolic-fill-partition-camera', 160, 72],
  ['symbolic-text-corner', 16, 40], ['symbolic-text-camera', 208, 72],
  ['symbolic-text-instances', 108, 40], ['symbolic-text-rte-deltas', 32, 40],
]);
const require = (ok, reason) => { if (!ok) throw new Error(`Symbolic qualification refused: ${reason}`); };
const clean = value => value?.status === 'complete' && value.zombies === 0 && value.remaining?.length === 0;
export function requireFrozenSources(before, after) {
  require(isDeepStrictEqual(before, after), 'source/Node/head freeze changed');
}
export function qualifySymbolicUpload(capture, frozen) {
  const { row, refusal, exit, cleanup, flushes, backend } = capture, gpu = row.gpu;
  require(!refusal && exit.code === 0 && exit.signal == null && clean(cleanup), 'outer child/ownership/cleanup');
  require(flushes.length === 2 && flushes.every(x => x.status === 'complete'), 'full raw log drain');
  require(!backend.length && !row.eventRefusal && !row.censusRefusal && !row.diagnosticRefusal, 'backend/prefix/census');
  require(row.status === 'observed-pending-outer-hosted-qualification' && row.browserClose === 'complete'
    && clean(row.childOwnedCleanup), 'standalone completion/cleanup');
  require(Array.isArray(row.events) && !row.events.some(e => ['pageerror', 'crash', 'console-error', 'diagnostic-refusal'].includes(e.kind)), 'all-phase events');
  require(row.harness.head === frozen.head && isDeepStrictEqual(row.harness.node, frozen.node), 'actual child source/Node');
  for (const [path, hash] of Object.entries(row.harness.files)) require(frozen.sources[path] === hash, 'child source ' + path);
  require(isDeepStrictEqual(Object.keys(row.harness.files).sort(), [...SYMBOLIC_CHILD_INPUTS].sort()), 'exact child input inventory');
  require(canSignalOwnedGroup(row.rootIdentity, row.rootIdentity), 'external PID/start/group witness');
  requireOwnedChrome([row.chrome], row.rootIdentity.pid, PROFILES[1].args);
  require(/^[a-f0-9]{64}$/.test(row.chrome.sha256) && typeof row.chrome.version === 'string', 'actual Chrome hash/version');
  require(gpu?.status === 'observed-gpu-upload-input-identity' && gpu.cleanup === 'complete'
    && gpu.cleanupFailures?.length === 0 && gpu.failures?.length === 0, 'GPU completion/errors/cleanup');
  require(gpu.deviceLossCompletion === 'owned-destruction-observed' && gpu.gpuEvents?.length === 1
    && gpu.gpuEvents[0].kind === 'device-lost' && gpu.gpuEvents[0].reason === 'destroyed'
    && gpu.gpuEvents[0].ending === true, 'only intentional final device loss');
  require(gpu.controls?.length === SYMBOLIC_ABI.length && gpu.shaderCompilations?.length === SYMBOLIC_ABI.length, 'six complete actual readbacks');
  require(isDeepStrictEqual(gpu.sourceMutation, { before: [9, 0x7fc12345, 0x80000000, 13, 17],
    after: Array(5).fill(0x55555555), mutationValue: 0x55555555 }), 'independent post-write source mutation');
  for (const [i, [label, size, usage]] of SYMBOLIC_ABI.entries()) {
    const r = gpu.controls[i], shader = gpu.shaderCompilations[i];
    require(r.label === label && r.size === size && r.usage === usage && r.mutationRejected === true, 'ABI/negative control ' + label);
    require([r.rawBytes, r.capturedBytes, r.declaredInputBytes].every(a => Array.isArray(a) && a.length === size
      && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) && isDeepStrictEqual(r.rawBytes, r.capturedBytes)
      && isDeepStrictEqual(r.rawBytes, r.declaredInputBytes) && new Set(r.rawBytes).size > 1, 'actual diverse independently planned bytes ' + label);
    require(shader.label === label && shader.size === size && shader.usage === usage && shader.truncated === false
      && Array.isArray(shader.messages) && shader.messages.length === shader.totalMessages
      && shader.messages.every(m => ['info', 'warning'].includes(m.type)), 'actual shader diagnostics ' + label);
  }
  require(isDeepStrictEqual(gpu.recorderDisposals.map(r => [r.phase, r.status, r.reason]),
    [['active-buffers', 'disposed', null], ['empty-text', 'disposed', null]]), 'all prototype restorations');
  const empty = gpu.emptyText;
  require(empty?.census?.fillPartitions === 0 && empty.census.textInstances === 0 && empty.buffers?.length === 2, 'empty allocation census');
  for (const [i, label, size, complete] of [[0, 'symbolic-text-corner', 16, true], [1, 'symbolic-text-camera', 208, false]]) {
    const r = empty.buffers[i]; require(r.label === label && r.size === size && r.usage === (i ? 72 : 40)
      && r.active === false && r.bytes === null && r.completeObservedCoverage === complete, 'honest inactive allocation ' + label);
  }
  return 'qualified-symbolic-upload-input-control';
}
