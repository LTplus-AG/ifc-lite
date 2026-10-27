// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageRetainedRuntimePeer } from './stage-retained-runtime-peer.mjs';

// #7955/#8184: load the staged driver with normal module resolution, without
// Node loader hooks or any /smlib directory. Missing fixture modules must fail.
test('staged runtime driver explicitly owns its inert peer and refuses replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'retained-runtime-peer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'retained-test');
  await stageRetainedRuntimePeer(out);
  const { RetainedDriver } = await import(pathToFileURL(join(out, 'retained-driver.mjs')));
  const { peers } = await import(pathToFileURL(join(out, 'peer.mjs')));
  const driver = new RetainedDriver();
  t.after(() => driver.retire());
  await driver.qualify();
  const result = await driver.evaluate(new Uint8Array([7, 7]), 1, 1, 4, 1, 0.001, 5, 4096);
  assert.equal(peers.length, 1, 'construction selected this fixture transport');
  assert.equal(driver.objectLive(result.object), true);
  assert.equal(peers[0].objects.size, 1, 'the temporary mesh was released');
  await assert.rejects(stageRetainedRuntimePeer(out), { code: 'EEXIST' });
  assert.equal(driver.objectLive(result.object), true, 'refused staging preserves the existing fixture');
});
