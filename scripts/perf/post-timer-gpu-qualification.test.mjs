/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROFILES } from './gpu-control.mjs';
import { POST_TIMER_CHILD_INPUTS, POST_TIMER_ROLES, postTimerExpectedBytes, qualifyPostTimerGpuInputs, requirePostTimerFreeze } from './post-timer-gpu-qualification.mjs';
const limits = { maxBufferSize: 268435456, maxTextureDimension2D: 8192, maxUniformBufferBindingSize: 65536, minUniformBufferOffsetAlignment: 256 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function witness() {
  // Declared receipt invariants only; actual GPU qualification remains UNRUN.
  const clean = () => ({ status: 'complete', zombies: 0, remaining: [] });
  const source = { width: 67, height: 35, usage: 22, format: 'rgba8unorm', mipLevelCount: 1, sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1 };
  const plans = [
    { uniform: false, offset: 12, length: 20012, source: { size: 20032, usage: 40 }, tiles: [
      { width: 2048, height: 3, pitch: 8192, stagingBytes: 24576, bytes: 20012, consumed: 0, bindOffset: 12, prefixWords: 0, bindingSize: 20012 }] },
    { uniform: true, offset: 12, length: 65792, source: { size: 66048, usage: 72 }, tiles: [
      { width: 2048, height: 8, pitch: 8192, stagingBytes: 65536, bytes: 65524, consumed: 0, bindOffset: 0, prefixWords: 3, bindingSize: 65536 },
      { width: 67, height: 1, pitch: 512, stagingBytes: 512, bytes: 268, consumed: 65524, bindOffset: 65536, prefixWords: 0, bindingSize: 272 }] },
    { width: 67, height: 35, length: 9380, source, tiles: [{ width: 67, height: 35, pitch: 512, stagingBytes: 17920, x: 0, y: 0, dx: 0, dy: 0 }] },
    { width: 61, height: 31, length: 7564, source, tiles: [{ width: 61, height: 31, pitch: 256, stagingBytes: 7936, x: 3, y: 2, dx: 0, dy: 0 }] },
  ];
  const frozen = { head: 'a'.repeat(40), node: { version: 'v22', executable: '/node', sha256: 'b'.repeat(64) }, sources: Object.fromEntries([...POST_TIMER_CHILD_INPUTS, 'outer-only'].map(k => [k, 'c'.repeat(64)])) };
  const row = { status: 'observed-pending-post-timer-inputs-v1', browserClose: 'complete', events: [], rootIdentity: { pid: 100, pgrp: 100, startTime: '1', state: 'S' },
    harness: { head: frozen.head, node: frozen.node, files: Object.fromEntries(POST_TIMER_CHILD_INPUTS.map(k => [k, frozen.sources[k]])) },
    chrome: { identity: { pid: 101, ppid: 100, startTime: '2' }, arguments: ['/opt/chrome/chrome', ...PROFILES[1].args], sha256: 'd'.repeat(64), version: '154' },
    gpu: { status: 'observed-pending-outer-qualification', cleanup: 'complete', errors: [], deviceLimits: limits,
      deviceLoss: { reason: 'destroyed', ending: true }, nativeMethodsUnchanged: true, wrongUsageRejected: true,
      negativeSources: { buffer: { size: 16, usage: 44 }, atlas: { width: 1, height: 1, usage: 23, format: 'rgba8unorm', mipLevelCount: 1, sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1 } },
      controls: POST_TIMER_ROLES.map((label, i) => { const bytes = postTimerExpectedBytes(i, limits); return { label, plan: plans[i], rawBytes: Array.from(bytes), sha256: sha(bytes), expectedSha256: sha(bytes), mutationRejected: true }; }),
      reader: { status: 'complete', operations: 4, tiles: 5, cleanupFailures: [], shaderDiagnostics: Array.from({ length: 5 }, () => ({ totalMessages: 0, messages: [] })) } } };
  return { frozen, capture: { row, exit: { code: 0, signal: null }, cleanup: clean(), flushes: [clean(), clean()], backend: [] } };
}
test('#6537 independent byte oracle fixes word offset/endian and alpha/subrectangle contracts', () => {
  assert.deepEqual([...postTimerExpectedBytes(0, limits).subarray(0, 8)], [12, 9, 6, 131, 16, 12, 8, 132]);
  assert.deepEqual([...postTimerExpectedBytes(2, limits).subarray(0, 8)], [0, 19, 5, 0, 1, 56, 76, 13]);
  assert.deepEqual([...postTimerExpectedBytes(3, limits).subarray(0, 4)], [137, 224, 4, 245]);
  assert.throws(() => postTimerExpectedBytes(4, limits), /role/);
});
test('#6537 four-role audit rejects independent byte, source, shader, ownership and cleanup defects', () => {
  const normal = witness(); assert.equal(qualifyPostTimerGpuInputs(normal.capture, normal.frozen).status, 'qualified-post-timer-gpu-input-control-v1');
  for (const change of [
    g => { g.controls[0].rawBytes[0] ^= 1; }, g => { g.controls[2].rawBytes[3] = 255; },
    g => { g.controls[3].sha256 = g.controls[2].sha256; }, g => { g.controls.reverse(); },
    g => { g.controls[1].plan.tiles[1].consumed--; }, g => { g.controls[1].plan.tiles[0].prefixWords = 0; },
    g => { g.controls[0].plan.source.usage = 41; }, g => { g.controls[2].plan.source.mipLevelCount = 2; },
    g => { g.controls[3].plan.tiles[0].x++; }, g => { g.controls[2].plan.tiles.push({ ...g.controls[2].plan.tiles[0] }); },
    g => { g.reader.shaderDiagnostics.pop(); }, g => { g.reader.shaderDiagnostics[0].messages.push({ type: 'error', message: 'bad' }); g.reader.shaderDiagnostics[0].totalMessages = 1; },
    g => { g.reader.cleanupFailures.push('destroy failed'); }, g => { g.reader.prefixRefusal = 'tail'; },
    g => { g.deviceLoss.ending = false; }, g => { g.nativeMethodsUnchanged = false; }, g => { g.errorPrefixRefused = true; },
    g => { delete g.negativeSources; }, g => { g.negativeSources.buffer.usage = 41; }, g => { g.negativeSources.buffer.size = 32; },
    g => { g.negativeSources.atlas.usage = 22; }, g => { g.negativeSources.atlas.width = 2; },
  ]) { const x = witness(); change(x.capture.row.gpu); assert.throws(() => qualifyPostTimerGpuInputs(x.capture, x.frozen)); }
  for (const change of [
    r => { delete r.harness.files[POST_TIMER_CHILD_INPUTS[0]]; r.harness.files['outer-only'] = 'c'.repeat(64); },
    r => { r.harness.node = { ...r.harness.node, sha256: 'e'.repeat(64) }; },
    r => { r.events.push({ kind: 'console-error', phase: 'teardown' }); }, r => { r.rootIdentity.pgrp++; },
    r => { r.chrome.arguments.push('--use-angle=default'); }, r => { r.browserClose = 'refused'; },
  ]) { const x = witness(); change(x.capture.row); assert.throws(() => qualifyPostTimerGpuInputs(x.capture, x.frozen)); }
  for (const change of [c => { c.refusal = 'tail'; }, c => { c.exit.signal = 'SIGTERM'; }, c => { c.cleanup.zombies++; }, c => { c.backend.push('Dawn error'); }, c => { c.flushes[0].status = 'refused'; }]) {
    const x = witness(); change(x.capture); assert.throws(() => qualifyPostTimerGpuInputs(x.capture, x.frozen));
  }
});
test('#6537 final source identity is independent from an otherwise valid receipt', () => {
  const { frozen } = witness(); requirePostTimerFreeze(frozen, structuredClone(frozen));
  const changed = structuredClone(frozen); changed.sources[POST_TIMER_CHILD_INPUTS[0]] = '0'.repeat(64);
  assert.throws(() => requirePostTimerFreeze(frozen, changed), /freeze changed/);
});
