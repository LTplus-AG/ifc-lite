/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// #9522/#9524: run real HTTP handler cases through the scripts CI/oracle lane.
test('the Dalux relay admits valid uploads and rejects other writes (#9524)', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  // A nested runner must not inherit the parent's IPC context or oracle reporter.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'tests/api/dalux-relay-upload.test.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  const count = output.match(/^# tests (\d+)$/m);
  assert.ok(count && Number(count[1]) > 0, `No API cases executed:\n${output}`);
});
