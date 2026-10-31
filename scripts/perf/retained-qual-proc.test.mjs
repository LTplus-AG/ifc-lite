/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { startSampler } from './retained-qual-proc.mjs';

const linux = process.platform === 'linux';
// A child that holds ~120 MB, spawns a grandchild holding ~60 MB, and waits to be told to exit.
const CHILD = `const hold = n => { const b = Buffer.alloc(n * 1024 * 1024, 1); return b; };
const keep = hold(120);
const { spawn } = require('node:child_process');
const grand = spawn(process.execPath, ['-e', 'const b = Buffer.alloc(60*1024*1024,1); setInterval(()=>b[0]++, 50)'], { stdio: 'ignore' });
process.stdin.on('data', () => { grand.kill(); process.exit(keep[0] ? 0 : 1); });
setInterval(() => keep[0]++, 50);`;

test('sampler follows descendants only, and reports HWM and concurrent RSS', { skip: !linux && 'Linux /proc only' }, async () => {
  const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['pipe', 'ignore', 'ignore'] });
  const sampler = startSampler(child.pid, { intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const summary = sampler.stop();
  child.stdin.end('x');
  await new Promise(resolve => child.on('close', resolve));
  assert.ok(summary.processes >= 2, `saw ${summary.processes} processes`);
  assert.ok(summary.maxIndividualHwmKiB > 120 * 1024, `child HWM ${summary.maxIndividualHwmKiB}`);
  assert.ok(summary.maxObservedConcurrentRssKiB > 170 * 1024, `concurrent ${summary.maxObservedConcurrentRssKiB}`);
  assert.ok(summary.samples > 10);
  assert.match(summary.caveat, /short-lived/);
  assert.ok(!(process.pid in summary.byPid), 'the sampler must not read its own process');
});

test('the include filter keeps only the named executable (the SMLib worker case)', { skip: !linux && 'Linux /proc only' }, async () => {
  const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['pipe', 'ignore', 'ignore'] });
  const sampler = startSampler(child.pid, { intervalMs: 20, include: info => info.exe === 'no-such-worker' });
  await new Promise(resolve => setTimeout(resolve, 400));
  const summary = sampler.stop();
  child.stdin.end('x');
  await new Promise(resolve => child.on('close', resolve));
  assert.equal(summary.processes, 0);
  assert.equal(summary.maxIndividualHwmKiB, null, 'no matching worker is null, not zero');
  assert.equal(summary.maxObservedConcurrentRssKiB, null);
  assert.ok(basename(process.execPath).length > 0);
});

test('a process that already exited samples to nothing without throwing', { skip: !linux && 'Linux /proc only' }, () => {
  const summary = startSampler(2 ** 22 - 1, { intervalMs: 20 }).stop();
  assert.equal(summary.processes, 0);
});
