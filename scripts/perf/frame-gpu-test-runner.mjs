/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run actual inner controls rather than inheriting node:test's child-v8 mode. */
export function runFrameControls(context, files, timeout = 60_000) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(`${root}/node_modules/.bin/tsx`, ['--test', ...files], {
    cwd: root, env, encoding: 'utf8', timeout,
  });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`);
  context.diagnostic(run.stdout.trim());
}
