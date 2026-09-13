/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { REVERT_ORACLE_ADAPTERS } from './lib/revert-oracle-adapters.mjs';
import { EXPECTED_PROBES, validateAdapterManifest, validateSelfcheckResult } from './revert-oracle-selfcheck.mjs';

test('#4109: adapter IDs are the executable supported-runner manifest', () => {
  validateAdapterManifest();
  assert.deepEqual(REVERT_ORACLE_ADAPTERS.map((adapter) => adapter.id), [
    'cargo', 'python-pytest', 'root-node-test', 'vitest', 'node-test', 'typescript',
  ]);
});

test('#4109: corrupting one expected selfcheck value makes the selfcheck fail', () => {
  const corrupt = { ...EXPECTED_PROBES, observed: ['pass'] };
  const failure = validateSelfcheckResult('node-test', 'observed', { verdict: 'OBSERVED' }, corrupt);
  assert.match(failure, /expected pass, got OBSERVED/);
});

test('#4109: removing runner provisioning fails by naming the lost adapter', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/revert-oracle-selfcheck.mjs'), '--adapter', 'python-pytest'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lost runner python-pytest: python3 is unavailable/);
});

test('#4109: a supported file has exactly one claimant and an unknown runner has none', () => {
  const vitest = { kind: 'javascript', rootPackage: false, script: 'vitest run', file: 'src/a.test.ts' };
  assert.equal(REVERT_ORACLE_ADAPTERS.filter((adapter) => adapter.claim(vitest)).length, 1);
  assert.equal(REVERT_ORACLE_ADAPTERS.filter((adapter) => adapter.claim({ kind: 'go', file: 'x_test.go' })).length, 0);
});
