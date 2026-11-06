/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

export function tscRunDetails(run) {
  return `TypeScript status=${run.status}, signal=${run.signal}, error=${run.error?.message ?? 'none'}\nstdout:\n${run.stdout ?? ''}\nstderr:\n${run.stderr ?? ''}`;
}

// tsc completes with 0 (clean), 1 (diagnostics, emit skipped) or 2
// (diagnostics, outputs generated). Classification still rejects non-diagnostics.
// pnpm can instead return a numeric crash status, even after partial diagnostics.
export function assertCompleteTscRun(run) {
  assert.ok(!run.error && !run.signal && [0, 1, 2].includes(run.status),
    `TypeScript must run to completion\n${tscRunDetails(run)}`);
}
