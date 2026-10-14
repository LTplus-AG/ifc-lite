/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runOwnedChild } from './frame-gpu-owned-child.js';

async function fixture(run: (root: string, fd: number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), '6975-owned-child-'));
  const fd = openSync(join(root, 'child.log'), 'wx');
  try { await run(root, fd); }
  finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}

const options = (root: string, fd: number, code: string) => ({
  command: process.execPath, args: ['-e', code], cwd: root, stdout: fd, stderr: fd, timeoutMs: 10_000, graceMs: 300,
});

test('#6975 owned child preserves real exit failure and refuses pre-aborted launch', () => fixture(async (root, fd) => {
  const failure = await runOwnedChild(options(root, fd, 'process.exit(7)'));
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.timedOut, false);
  assert.equal(failure.cleanupErrors.length, 0);
  const aborted = new AbortController(); aborted.abort();
  const refusal = await runOwnedChild({ ...options(root, fd, 'require("node:fs").writeFileSync("unexpected", "ran")'), signal: aborted.signal });
  assert.equal(refusal.pid, null);
  assert.equal(refusal.aborted, true);
  assert.equal(existsSync(join(root, 'unexpected')), false);
}));

test('#6975 timeout stops the actual stubborn child and its descendant with verified identities', () => fixture(async (root, fd) => {
  const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)';
  const code = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('pids',JSON.stringify([process.pid,c.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
  const result = await runOwnedChild({ ...options(root, fd, code), timeoutMs: 1500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(result.cleanupErrors, []);
  const pids: unknown = JSON.parse(readFileSync(join(root, 'pids'), 'utf8'));
  assert.ok(Array.isArray(pids));
  for (const pid of pids) {
    assert.ok(result.observed.some((row) => row.pid === pid));
    const path = `/proc/${pid}/stat`;
    let stat: string;
    try { stat = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') continue;
      throw error;
    }
    assert.equal(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0], 'Z');
  }
}));

test('#6975 stopping one owned session leaves a real unrelated child running', () => fixture(async (root, fd) => {
  const foreignAbort = new AbortController();
  const foreign = runOwnedChild({ ...options(root, fd, 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync("foreign-heartbeat","."),20)'), signal: foreignAbort.signal });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(join(root, 'foreign-heartbeat')); attempt++) await sleep(20);
    assert.ok(existsSync(join(root, 'foreign-heartbeat')));
    const owned = await runOwnedChild({ ...options(root, fd, 'setInterval(()=>{},100)'), timeoutMs: 100 });
    assert.equal(owned.timedOut, true);
    assert.deepEqual(owned.cleanupErrors, []);
    const before = statSync(join(root, 'foreign-heartbeat')).size;
    await sleep(100);
    assert.ok(statSync(join(root, 'foreign-heartbeat')).size > before);
  } finally {
    foreignAbort.abort();
    const result = await foreign;
    assert.equal(result.aborted, true);
    assert.deepEqual(result.cleanupErrors, []);
  }
}));
