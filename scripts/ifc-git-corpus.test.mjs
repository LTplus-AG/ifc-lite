/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// #8197: execute the real generator and its pinned data/geometry assertions.
// The existing scripts/*.test.mjs CI invocation runs this witness too.
test('the complete ifc-git revision chain matches its data and geometry declarations (#8197)', { timeout: 90_000 }, t => {
  const result = spawnSync('pnpm', ['tsx', 'tools/ifc-git-corpus/derive-revisions.mts', '--check'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 3) {
    t.skip('Corpus build prerequisites absent; run pnpm install && pnpm build. No geometry evidence was checked.');
    return;
  }
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
});
