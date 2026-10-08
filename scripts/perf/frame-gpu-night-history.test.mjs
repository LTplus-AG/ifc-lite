/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Reached by test.yml's scripts/perf/*.test.mjs catch-all. The TS source and
// controls also belong to the permanent root typecheck programme.
test('#6975 nightly-calendar production invariants', (context) => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  // A nested `node --test` must create its own runner. Inheriting the parent
  // runner's child-v8 context suppresses the nested controls and exits green.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(`${root}/node_modules/.bin/tsx`, ['--test', 'scripts/perf/frame-gpu-night-history.test.ts', 'scripts/perf/frame-gpu-night-profile.test.ts'], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`);
  context.diagnostic(run.stdout.trim());
});
