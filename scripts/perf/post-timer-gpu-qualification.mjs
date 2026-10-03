/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROFILES, canSignalOwnedGroup, requireOwnedChrome } from './gpu-control.mjs';
export const POST_TIMER_CHILD_INPUTS = Object.freeze([
  ...['post-timer-gpu-child.mjs', 'post-timer-gpu-readback.mjs', 'post-timer-gpu-readback-control.mjs',
    'post-timer-gpu-qualification.mjs', 'gpu-control.mjs', 'interleaved-cleanup.mjs'].map(n => 'scripts/perf/' + n),
  'package.json', 'pnpm-lock.yaml',
]);
export const POST_TIMER_ROLES = Object.freeze(['vertex-multiple-rows', 'uniform-window-boundary', 'atlas-all-channels-alpha', 'atlas-subrectangle']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uint = n => Number.isSafeInteger(n) && n >= 0;
const clean = r => r?.status === 'complete' && r.zombies === 0 && r.remaining?.length === 0;
export function requirePostTimerFreeze(before, after) {
  if (!isDeepStrictEqual(before, after)) throw new Error('Post-timer source/head/Node freeze changed');
}
// Independent literal oracle: does not import the GPU reader/planner or use their bytes.
export function postTimerExpectedBytes(role, limits) {
  if (role < 2) {
    const length = role === 0 ? 20012 : limits.maxUniformBufferBindingSize + 256;
    if (!uint(length) || length > 2 * 1024 * 1024 || length % 4) throw new Error('Finite oracle word length required');
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += 4) bytes.writeUInt32LE((0x80000000 + (3 + offset / 4) * 0x1020304) >>> 0, offset);
    return bytes;
  }
  if (role !== 2 && role !== 3) throw new Error('Declared oracle role required');
  const width = role === 2 ? 67 : 61, height = role === 2 ? 35 : 31;
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = role === 2 ? y * 67 + x : (y + 2) * 67 + x + 3, offset = (y * width + x) * 4;
    bytes[offset] = i % 256; bytes[offset + 1] = (i * 37 + 19) % 256;
    bytes[offset + 2] = (i * 71 + 5) % 256; bytes[offset + 3] = (i * 13) % 256;
  }
  return bytes;
}
export function qualifyPostTimerGpuInputs(capture, frozen) {
  const checks = [];
  const require = (ok, label) => { checks.push({ label, passed: Boolean(ok) }); if (!ok) throw new Error('Post-timer qualification refused: ' + label); };
  const { row, exit, cleanup, flushes, backend, refusal } = capture, gpu = row.gpu;
  require(!refusal && exit.code === 0 && exit.signal == null && clean(cleanup), 'outer exit/owned cleanup');
  require(flushes.length === 2 && flushes.every(r => r.status === 'complete') && !backend.length, 'full raw drain/backend');
  require(row.status === 'observed-pending-post-timer-inputs-v1' && row.browserClose === 'complete'
    && !row.eventPrefixRefused && !row.interrupted, 'child completion/event prefix');
  require(Array.isArray(row.events) && !row.events.some(e => ['pageerror', 'crash', 'console-error'].includes(e.kind)), 'all-phase page errors');
  require(row.harness.head === frozen.head && isDeepStrictEqual(row.harness.node, frozen.node), 'actual child head/Node');
  require(isDeepStrictEqual(Object.keys(row.harness.files).sort(), [...POST_TIMER_CHILD_INPUTS].sort()), 'exact child inventory');
  for (const path of POST_TIMER_CHILD_INPUTS) require(row.harness.files[path] === frozen.sources[path] && /^[a-f0-9]{64}$/.test(row.harness.files[path]), 'literal child source ' + path);
  require(canSignalOwnedGroup(row.rootIdentity, row.rootIdentity), 'detached PID/start/group witness');
  requireOwnedChrome([row.chrome], row.rootIdentity.pid, PROFILES[1].args);
  require(/^[a-f0-9]{64}$/.test(row.chrome.sha256) && typeof row.chrome.version === 'string' && row.chrome.version.length > 0, 'observed Chrome binary/version');
  require(gpu?.status === 'observed-pending-outer-qualification' && gpu.cleanup === 'complete'
    && gpu.errors?.length === 0 && !gpu.errorPrefixRefused, 'GPU completion/error ledger');
  require(gpu.deviceLoss?.ending === true && gpu.deviceLoss.reason === 'destroyed', 'only owned final device destruction');
  require(gpu.nativeMethodsUnchanged === true && gpu.wrongUsageRejected === true, 'native methods/original usages');
  require(isDeepStrictEqual(gpu.negativeSources, { buffer: { size: 16, usage: 44 },
    atlas: { width: 1, height: 1, usage: 23, format: 'rgba8unorm', mipLevelCount: 1, sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1 } }), 'actual legal augmented negative source descriptors');
  const limits = gpu.deviceLimits;
  require(['maxBufferSize', 'maxTextureDimension2D', 'maxUniformBufferBindingSize', 'minUniformBufferOffsetAlignment'].every(k => uint(limits?.[k]) && limits[k] > 0)
    && limits.maxUniformBufferBindingSize % 16 === 0 && limits.maxUniformBufferBindingSize + 512 <= 2 * 1024 * 1024
    && limits.minUniformBufferOffsetAlignment % 16 === 0, 'finite actual device limits');
  require(gpu.controls?.length === 4 && isDeepStrictEqual(gpu.controls.map(c => c.label), POST_TIMER_ROLES), 'exact four ordered roles');
  let tileCount = 0;
  for (const [i, control] of gpu.controls.entries()) {
    const expected = postTimerExpectedBytes(i, limits), plan = control.plan;
    require(Array.isArray(control.rawBytes) && control.rawBytes.length === expected.length
      && control.rawBytes.every(n => uint(n) && n <= 255), 'finite complete bytes ' + control.label);
    const actual = Buffer.from(control.rawBytes), digest = sha(expected);
    require(actual.equals(expected) && control.sha256 === digest && control.expectedSha256 === digest, 'independent byte/hash oracle ' + control.label);
    const changed = Buffer.from(actual); changed[Math.floor(changed.length / 2)] ^= 1;
    require(control.mutationRejected === true && sha(changed) !== digest && new Set(actual).size > 1, 'byte mutation/diversity ' + control.label);
    require(plan?.length === expected.length && Array.isArray(plan.tiles) && plan.tiles.length > 0 && plan.tiles.length <= 2048, 'finite read plan ' + control.label);
    for (const t of plan.tiles) require([t.width, t.height, t.pitch, t.stagingBytes].every(uint) && t.width > 0 && t.height > 0
      && t.width <= limits.maxTextureDimension2D && t.height <= limits.maxTextureDimension2D
      && t.pitch >= t.width * 4 && t.pitch % 256 === 0 && t.stagingBytes === t.pitch * t.height
      && t.stagingBytes <= Math.min(4 * 1024 * 1024, limits.maxBufferSize), 'owned tile bounds ' + control.label);
    tileCount += plan.tiles.length;
    if (i < 2) {
      const size = i ? limits.maxUniformBufferBindingSize + 512 : 20032;
      require(plan.uniform === Boolean(i) && plan.offset === 12 && isDeepStrictEqual(plan.source, { size, usage: i ? 72 : 40 }) && size <= limits.maxBufferSize, 'original buffer descriptor ' + control.label);
      let consumed = 0;
      for (const t of plan.tiles) {
        require([t.bytes, t.consumed, t.bindOffset, t.prefixWords, t.bindingSize].every(uint)
          && t.bytes > 0 && t.bytes % 4 === 0 && t.consumed === consumed
          && t.bindOffset + t.prefixWords * 4 === 12 + consumed
          && t.bindingSize >= t.prefixWords * 4 + t.bytes && t.bindOffset + t.bindingSize <= size
          && t.bytes <= t.width * t.height * 4 && t.bytes > t.width * (t.height - 1) * 4, 'word coverage ' + control.label);
        require(i ? t.bindOffset % limits.minUniformBufferOffsetAlignment === 0 && t.bindingSize % 16 === 0 && t.bindingSize <= limits.maxUniformBufferBindingSize
          : t.prefixWords === 0 && t.bindingSize === t.bytes, 'original binding window ' + control.label);
        consumed += t.bytes;
      }
      require(consumed === expected.length, 'full used word range ' + control.label);
    } else {
      const width = i === 2 ? 67 : 61, height = i === 2 ? 35 : 31, x = i === 2 ? 0 : 3, y = i === 2 ? 0 : 2;
      require(plan.width === width && plan.height === height && isDeepStrictEqual(plan.source,
        { width: 67, height: 35, usage: 22, format: 'rgba8unorm', mipLevelCount: 1, sampleCount: 1, dimension: '2d', depthOrArrayLayers: 1 }), 'original single-mip atlas descriptor ' + control.label);
      for (const t of plan.tiles) require([t.dx, t.dy, t.x, t.y].every(uint) && t.dx + t.width <= width && t.dy + t.height <= height
        && t.x === x + t.dx && t.y === y + t.dy, 'atlas source coordinates ' + control.label);
      for (let row = 0; row < height; row++) {
        const intervals = plan.tiles.filter(t => t.dy <= row && row < t.dy + t.height).map(t => [t.dx, t.dx + t.width]).sort((a, b) => a[0] - b[0]);
        let cursor = 0; for (const [start, end] of intervals) { require(start === cursor, 'no atlas gaps/overlap ' + control.label); cursor = end; }
        require(cursor === width, 'full atlas row ' + control.label);
      }
    }
  }
  const reader = gpu.reader;
  require(tileCount <= 2048 && reader?.status === 'complete' && reader.operations === 4 && reader.tiles === tileCount
    && !reader.prefixRefusal && !reader.deviceLoss && reader.cleanupFailures?.length === 0, 'reader count/loss/cleanup');
  require(Array.isArray(reader.shaderDiagnostics) && reader.shaderDiagnostics.length === tileCount
    && Buffer.byteLength(reader.shaderDiagnostics.map(d => JSON.stringify(d)).join('')) <= 128 * 1024, 'complete UTF8 diagnostic budget');
  for (const diagnostic of reader.shaderDiagnostics) require(Array.isArray(diagnostic.messages)
    && diagnostic.totalMessages === diagnostic.messages.length && diagnostic.messages.length <= 32
    && diagnostic.messages.every(m => ['info', 'warning'].includes(m.type) && typeof m.message === 'string' && Buffer.byteLength(m.message) <= 4096), 'all shader diagnostics');
  return { status: 'qualified-post-timer-gpu-input-control-v1', checks };
}
