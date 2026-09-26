/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestProgram, GENERATED_CONFIG } from './typecheck-tests.mjs';
import { classifyTscOutput } from './lib/unused-locals-classify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('viewer-embed unused-locals baseline matches the measured count (#6093)', () => {
  const packageDir = join(root, 'apps/viewer-embed');
  const project = writeTestProgram(packageDir) ? GENERATED_CONFIG : 'tsconfig.json';
  const run = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '--noUnusedLocals', '--pretty', 'false', '-p', project], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  assert.equal(run.error, undefined, 'TypeScript must run to completion');
  assert.equal(typeof run.status, 'number', 'TypeScript must exit normally');
  const measured = classifyTscOutput(`${run.stdout}${run.stderr}`);
  assert.equal(measured.kind, 'violations', 'the count must come from complete unused-local diagnostics');
  const baseline = JSON.parse(readFileSync(join(root, 'scripts/unused-locals-baseline.json'), 'utf8'));
  assert.equal(measured.count, baseline['apps/viewer-embed']);
});
