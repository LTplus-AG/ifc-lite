/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runUnusedLocals(project, cwd) {
  // #8981: this includes viewer tests and exceeds Node 22's default 4 GiB heap.
  // Invoke Node directly: pnpm converts SIGABRT into ordinary exit status 1.
  return spawnSync(process.execPath, [
    '--max-old-space-size=8192',
    fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--noUnusedLocals', '--pretty', 'false', '-p', project,
  ], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}

export function tscRunDetails(run) {
  return `TypeScript status=${run.status}, signal=${run.signal}, error=${run.error?.message ?? 'none'}\nstdout:\n${run.stdout ?? ''}\nstderr:\n${run.stderr ?? ''}`;
}

// tsc completes with 0 (clean), 1 (diagnostics, emit skipped) or 2
// (diagnostics, outputs generated). Classification still rejects non-diagnostics.
// Reject signals, truncated output and non-compiler exit statuses before counting.
export function assertCompleteTscRun(run) {
  assert.ok(!run.error && !run.signal && [0, 1, 2].includes(run.status),
    `TypeScript must run to completion\n${tscRunDetails(run)}`);
}
