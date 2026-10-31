/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_LOSS_PATTERNS, GPU_ARGS, deviceLossCount, isSoftwareAdapter, raceWithTimeout, treeDigest } from './retained-qual-browser.mjs';

test('device-loss patterns are the ones tests/benchmark/gpu-health.ts uses', () => {
  const source = readFileSync(new URL('../../tests/benchmark/gpu-health.ts', import.meta.url), 'utf8');
  for (const pattern of DEVICE_LOSS_PATTERNS) assert.ok(source.includes(`pattern: ${pattern.toString()}`), `gpu-health.ts lacks ${pattern}`);
});

test('swiftshader flags are the viewer-retained project flags in playwright.config.ts', () => {
  const config = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8');
  const block = config.slice(config.indexOf("name: 'viewer-retained'"), config.indexOf("name: 'viewer-retained-default'"));
  for (const arg of GPU_ARGS.swiftshader) assert.ok(block.includes(`'${arg}'`), `playwright.config.ts viewer-retained lacks ${arg}`);
  assert.ok(GPU_ARGS.hardware.includes('--use-angle=vulkan') && !GPU_ARGS.hardware.some(a => /swiftshader/.test(a)));
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
