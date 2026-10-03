/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from './gpu-control.mjs';
import { SYMBOLIC_ABI, SYMBOLIC_CHILD_INPUTS, qualifySymbolicUpload, requireFrozenSources } from './symbolic-upload-qualification.mjs';
// Stated receipt invariants; actual GPU production is separately UNRUN.
function witness() {
  const clean = () => ({ status: 'complete', zombies: 0, remaining: [] });
  const frozen = { head: 'head', node: { version: 'node', executable: '/node', sha256: 'a'.repeat(64) },
    sources: Object.fromEntries([...SYMBOLIC_CHILD_INPUTS, 'outer-only'].map(path => [path, 'b'.repeat(64)])) };
  const row = { status: 'observed-pending-outer-hosted-qualification', browserClose: 'complete', events: [],
    childOwnedCleanup: clean(), rootIdentity: { pid: 100, pgrp: 100, startTime: '1', state: 'S' },
    harness: { ...frozen, files: Object.fromEntries(SYMBOLIC_CHILD_INPUTS.map(path => [path, frozen.sources[path]])) }, chrome: { identity: { pid: 101, ppid: 100, startTime: '2' },
      arguments: ['/opt/chrome/chrome', ...PROFILES[1].args], version: '154', sha256: 'c'.repeat(64) },
    gpu: { status: 'observed-gpu-upload-input-identity', cleanup: 'complete', cleanupFailures: [], failures: [],
      deviceLossCompletion: 'owned-destruction-observed', gpuEvents: [{ kind: 'device-lost', reason: 'destroyed', ending: true }],
      sourceMutation: { before: [9, 0x7fc12345, 0x80000000, 13, 17], after: Array(5).fill(0x55555555), mutationValue: 0x55555555 },
      controls: SYMBOLIC_ABI.map(([label, size, usage]) => ({ label, size, usage, mutationRejected: true,
        rawBytes: Array.from({ length: size }, (_, i) => i % 251),
        capturedBytes: Array.from({ length: size }, (_, i) => i % 251),
        declaredInputBytes: Array.from({ length: size }, (_, i) => i % 251) })),
      shaderCompilations: SYMBOLIC_ABI.map(([label, size, usage]) => ({ label, size, usage, truncated: false, totalMessages: 0, messages: [] })),
      recorderDisposals: ['active-buffers', 'empty-text'].map(phase => ({ phase, status: 'disposed', reason: null })),
      emptyText: { census: { fillPartitions: 0, textInstances: 0 }, buffers: [
        { label: 'symbolic-text-corner', size: 16, usage: 40, active: false, bytes: null, completeObservedCoverage: true },
        { label: 'symbolic-text-camera', size: 208, usage: 72, active: false, bytes: null, completeObservedCoverage: false }] } } };
  return { capture: { row, exit: { code: 0, signal: null }, cleanup: clean(), flushes: [clean(), clean()], backend: [] }, frozen };
}
test('#6537 symbolic certification requires actual receipt channels and rejects each independent loss', () => {
  const normal = witness(); assert.equal(qualifySymbolicUpload(normal.capture, normal.frozen), 'qualified-symbolic-upload-input-control');
  for (const change of [
    r => { delete r.harness.files[SYMBOLIC_CHILD_INPUTS[0]]; r.harness.files['outer-only'] = 'b'.repeat(64); },
    r => { r.gpu.controls[0].rawBytes.fill(0); r.gpu.controls[0].capturedBytes.fill(0); },
    r => { for (const key of ['rawBytes', 'capturedBytes', 'declaredInputBytes']) r.gpu.controls[0][key].fill(0); },
    r => { r.gpu.sourceMutation.after = [...r.gpu.sourceMutation.before]; },
    r => { r.gpu.controls.pop(); }, r => { r.gpu.controls[0].rawBytes[0]++; },
    r => { r.gpu.controls[1].size = 16; }, r => { r.gpu.controls[0].mutationRejected = false; },
    r => { r.gpu.recorderDisposals[0].status = 'refused'; }, r => { r.gpu.cleanup = 'refused'; },
    r => { r.gpu.shaderCompilations[0].messages.push({ type: 'error' }); },
    r => { r.gpu.gpuEvents[0].reason = 'unknown'; }, r => { r.childOwnedCleanup.zombies++; },
    r => { r.events.push({ kind: 'console-error', phase: 'teardown' }); },
    r => { r.harness.node = { ...r.harness.node, sha256: 'd'.repeat(64) }; },
    r => { r.chrome.arguments.push('--use-angle=default'); }, r => { r.rootIdentity.pgrp++; },
    r => { r.gpu.emptyText.buffers[1].bytes = [0]; },
  ]) { const x = witness(); change(x.capture.row); assert.throws(() => qualifySymbolicUpload(x.capture, x.frozen)); }
  for (const change of [c => { c.refusal = 'tail'; }, c => { c.exit.code = 1; },
    c => { c.backend.push('Dawn failure'); }, c => { c.flushes[0].status = 'refused'; }]) {
    const x = witness(); change(x.capture); assert.throws(() => qualifySymbolicUpload(x.capture, x.frozen));
  }
});
test('#6537 final source freeze refuses changed source and Node identities', () => {
  const { frozen } = witness(); requireFrozenSources(frozen, structuredClone(frozen));
  for (const edit of [x => { x.head = 'changed'; }, x => { x.sources[SYMBOLIC_CHILD_INPUTS[0]] = 'changed'; }, x => { x.node.sha256 = 'changed'; }]) {
    const after = structuredClone(frozen); edit(after); assert.throws(() => requireFrozenSources(frozen, after), /freeze changed/);
  }
});
