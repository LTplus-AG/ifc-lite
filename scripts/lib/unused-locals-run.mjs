/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

export function tscRunDetails(run) {
  return `TypeScript status=${run.status}, signal=${run.signal}, error=${run.error?.message ?? 'none'}\nstdout:\n${run.stdout ?? ''}\nstderr:\n${run.stderr ?? ''}`;
}

// With --noEmit, tsc completes with 0 (clean) or 2 (diagnostics, emit skipped).
// pnpm can instead return a numeric crash status, even after partial diagnostics.
export function assertCompleteTscRun(run) {
  assert.ok(!run.error && !run.signal && (run.status === 0 || run.status === 2),
    `TypeScript must run to completion\n${tscRunDetails(run)}`);
}
