/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

test('#4109: an early argument refusal emits exactly one oracle JSON record', () => {
  const result = spawnSync(process.execPath, [oracle, '--json', '--not-a-real-option'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const record = JSON.parse(result.stdout);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.channel, 'oracle');
  assert.equal(record.verdict, 'ERROR');
  assert.equal(record.exitCode, 2);
  assert.match(record.reason, /unknown argument/);
});
