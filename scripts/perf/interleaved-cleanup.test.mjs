/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, createWriteStream, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { finishLog, processIdentity, stopWitnessedProcesses } from './interleaved-cleanup.mjs';

test('#6537 awaited runner log finish preserves buffered terminal output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'interleaved-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'runner.log'), log = createWriteStream(path, { highWaterMark: 16 });
  const body = Buffer.alloc(1024 * 1024, 97);
  log.write(body); log.write('\nterminal refusal\n');
  const receipt = await finishLog(log, 2000);
  assert.equal(receipt.status, 'complete');
  assert.equal(readFileSync(path).byteLength, body.byteLength + Buffer.byteLength('\nterminal refusal\n'));
  assert.ok(readFileSync(path, 'utf8').endsWith('\nterminal refusal\n'));
});

test('#6537 owned cleanup observes exit and never signals a stale PID/start-time witness', { timeout: 5000 }, async t => {
  if (process.platform !== 'linux') { t.skip('Linux /proc cleanup invariant'); return; }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  const witness = processIdentity(child.pid);
  assert.ok(witness);
  const stale = await stopWitnessedProcesses([{ ...witness, startTime: 'different' }], 1000);
  assert.equal(stale.status, 'complete');
  assert.equal(processIdentity(child.pid).startTime, witness.startTime);
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  const receipt = await stopWitnessedProcesses([witness], 1000);
  await closed;
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(receipt.remaining, []);
});
