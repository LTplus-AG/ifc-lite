/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_LOSS_PATTERNS, GPU_ARGS, deviceLossCount, isSoftwareAdapter, raceWithTimeout, treeDigest } from './retained-qual-browser.mjs';

test('the renderer and viewer device-loss lines are recognised, and ordinary lines are not', () => {
  // Real log formats (packages/renderer device.ts / index.ts, apps/viewer device-loss-report.ts).
  const lines = ['[WebGPU] Device lost: GPUDevice destroyed (reason: destroyed)', '[Renderer] GPU device lost — halting rendering until re-init: x', '[Viewport] GPU device lost: x'];
  for (const [i, pattern] of DEVICE_LOSS_PATTERNS.entries()) {
    assert.ok(pattern.test(lines[i]), `pattern ${i}`);
    assert.ok(DEVICE_LOSS_PATTERNS.every((other, j) => j === i || !other.test(lines[i])), `line ${i} matches only its own site`);
  }
  assert.ok(!DEVICE_LOSS_PATTERNS.some(pattern => pattern.test('[WebGPU] Uncaptured error: x')), 'an uncaptured error is not a loss');
});

test('software flags name SwiftShader, hardware flags never do', () => {
  assert.ok(GPU_ARGS.swiftshader.some(arg => /swiftshader/.test(arg)));
  assert.ok(GPU_ARGS.hardware.includes('--use-angle=vulkan') && !GPU_ARGS.hardware.some(arg => /swiftshader/.test(arg)));
  assert.ok([...GPU_ARGS.swiftshader, ...GPU_ARGS.hardware].includes('--enable-unsafe-webgpu'));
});

test('one loss printed at several sites counts once (largest per-site count, never the sum)', () => {
  const lines = ['[WebGPU] Device lost: x (reason: unknown)', '[Renderer] GPU device lost — halting rendering until re-init: x', '[Viewport] GPU device lost: x', 'unrelated'];
  assert.equal(deviceLossCount(lines), 1);
  assert.equal(deviceLossCount([...lines, lines[0]]), 2);
  assert.equal(deviceLossCount(['fine']), 0);
});

test('software adapters are recognised so a smoke run is never labelled hardware', () => {
  assert.equal(isSoftwareAdapter(null), true);
  assert.equal(isSoftwareAdapter({ vendor: 'google', architecture: 'swiftshader', fallback: false }), true);
  assert.equal(isSoftwareAdapter({ vendor: 'nvidia', architecture: 'lovelace', fallback: true }), true);
  assert.equal(isSoftwareAdapter({ vendor: 'nvidia', architecture: 'lovelace', fallback: false }), false);
});

test('a stuck operation is a named timeout, not a hang', async () => {
  await assert.rejects(raceWithTimeout(new Promise(() => {}), 20, 'close'), /close timed out after 20 ms/);
  assert.equal(await raceWithTimeout(Promise.resolve(3), 1000, 'x'), 3);
});

test('served-tree digest is deterministic and changes with any byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'));
  try {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a/x.js'), '1');
    writeFileSync(join(dir, 'index.html'), 'h');
    const first = treeDigest(dir);
    assert.deepEqual(treeDigest(dir), first);
    assert.equal(first.files, 2);
    writeFileSync(join(dir, 'a/x.js'), '2');
    assert.notEqual(treeDigest(dir).sha256, first.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8413: failed and late launches remove profiles and close late contexts', async () => {
  const { launchFresh } = await import('./retained-qual-browser.mjs');
  const { existsSync } = await import('node:fs');
  for (const mode of ['reject', 'late', 'page']) {
    let profile, closed = 0;
    const context = { pages: () => [], newPage: () => new Promise(() => {}), close: async () => { closed++; } };
    const chromium = { launchPersistentContext: path => {
      profile = path;
      if (mode === 'reject') return Promise.reject(new Error('bad executable'));
      if (mode === 'late') return new Promise(resolve => setTimeout(() => resolve(context), 20));
      return Promise.resolve(context);
    } };
    await assert.rejects(launchFresh({ chromium, closeMs: 5 }), /bad executable|timed out/);
    assert.equal(closed, mode === 'reject' ? 0 : 1, 'cleanup completes before rejection');
    assert.equal(existsSync(profile), false);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(closed, mode === 'reject' ? 0 : 1);
    assert.equal(existsSync(profile), false);
  }
});

test('8413: digest uses codepoint ordering for mixed case and punctuation', async () => {
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'qual-digest-'));
  try {
    for (const name of ['a', 'Z', '_']) writeFileSync(join(dir, name), name);
    const hash = value => createHash('sha256').update(value).digest('hex');
    assert.equal(treeDigest(dir).sha256, hash(['Z', '_', 'a'].map(name => `${name} 1 ${hash(name)}`).join('\n')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8413: missing preview executable rejects without an unhandled process error', async () => {
  const { startPreview } = await import('./retained-qual-browser.mjs');
  await assert.rejects(startPreview({ checkout: '/missing-8413', engine: '/unused' }, 19843, { ready: 1000 }), /ENOENT/);
});

test('8413: second preview spawn failure tears down the first arm before rejecting', async () => {
  const { startPreviews, startPreview } = await import('./retained-qual-browser.mjs');
  let stopped = false;
  await assert.rejects(startPreviews([{ side: 'base' }, { side: 'branch' }], 19844, async arm => {
    if (arm.side === 'base') return { stop: async () => { stopped = true; } };
    return startPreview({ checkout: '/missing-8413', engine: '/unused' }, 19845, { ready: 1000 });
  }), /ENOENT/);
  assert.equal(stopped, true);
});

test('8413: unresolved launch cleanup is bounded and marks the run unsafe to continue', async () => {
  const { launchFresh } = await import('./retained-qual-browser.mjs');
  let profile;
  try {
    await assert.rejects(launchFresh({ closeMs: 5, cleanupMs: 10, chromium: {
      launchPersistentContext: path => { profile = path; return new Promise(() => {}); },
    } }), error => error.cleanupFailed === true && /cleanup/.test(error.message));
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
