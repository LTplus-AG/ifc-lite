/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertCompleteTscRun } from './unused-locals-run.mjs';

for (const status of [0, 1, 2, 134, 137]) {
  test(`#8981: compiler outcome ${status} retains diagnostics and rejects incomplete census`, () => {
    const run = spawnSync(process.execPath, ['-e', `
      console.log("src/a.ts(1,1): error TS6133: unused");
      console.error("compiler stderr sentinel");
      process.exit(${status});
    `], { encoding: 'utf8' });
    if (status <= 2) assert.doesNotThrow(() => assertCompleteTscRun(run));
    else assert.throws(() => assertCompleteTscRun(run), (error) => {
      assert.match(error.message, new RegExp(`status=${status}`));
      assert.match(error.message, /TS6133: unused/);
      assert.match(error.message, /compiler stderr sentinel/);
      return true;
    });
  });
}

test('#8981: truncated output cannot pass as a completed census', () => {
  const run = spawnSync(process.execPath, ['-e', 'console.log("x".repeat(100000))'],
    { encoding: 'utf8', maxBuffer: 128 });
  assert.throws(() => assertCompleteTscRun(run), /ENOBUFS/);
});

test('#8981: a signalled compiler cannot supply a complete census', { skip: process.platform === 'win32' }, () => {
  const run = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { encoding: 'utf8' });
  assert.throws(() => assertCompleteTscRun(run), /signal=SIGTERM/);
});


test('#8981: real tsc noEmit diagnostics are a completed census', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'unused-locals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'input.ts'), 'export {}; const unused = 1;');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { noEmit: true, noUnusedLocals: true, types: [], lib: ['es5'] },
    files: ['input.ts'],
  }));
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--pretty', 'false', '-p', join(dir, 'tsconfig.json'),
  ], { encoding: 'utf8' });
  assertCompleteTscRun(run);
  assert.match(run.stdout, /error TS6133:/);
  assert.notEqual(run.status, 0);
});
