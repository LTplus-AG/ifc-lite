/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestProgram, GENERATED_CONFIG } from './typecheck-tests.mjs';
import { classifyTscOutput } from './lib/unused-locals-classify.mjs';
import { assertCompleteTscRun, tscRunDetails, runUnusedLocals } from './lib/unused-locals-run.mjs';
import { isCI } from './lib/host-preconditions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('viewer-embed unused-locals baseline matches the measured count (#6093)', (t) => {
  const packageDir = join(root, 'apps/viewer-embed');
  const project = writeTestProgram(packageDir) ? GENERATED_CONFIG : 'tsconfig.json';
  const run = runUnusedLocals(project, packageDir);
  assertCompleteTscRun(run);
  const output = `${run.stdout}${run.stderr}`;
  // A workspace package that has not been built resolves to nothing, and every
  // file importing it then fails to compile, so the count is not a count. That
  // is a host without `pnpm build`, not a baseline mismatch. CI restores the
  // build output first, and a missing package THERE must still fail.
  if (!isCI() && /error TS2307: Cannot find module '@ifc-lite\//.test(output)) {
    t.skip('workspace packages are not built here (TS2307 on an @ifc-lite/* import); run `pnpm build`. CI never skips this test.');
    return;
  }
  const measured = classifyTscOutput(output);
  assert.equal(measured.kind, 'violations', `the count must come from complete unused-local diagnostics\n${tscRunDetails(run)}`);
  const baseline = JSON.parse(readFileSync(join(root, 'scripts/unused-locals-baseline.json'), 'utf8'));
  assert.equal(measured.count, baseline['apps/viewer-embed']);
  t.diagnostic(`complete viewer-embed census: ${measured.count} unused-local diagnostics (status ${run.status})`);
});
