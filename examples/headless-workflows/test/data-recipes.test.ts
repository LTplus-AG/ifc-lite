/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = new URL('../../../', import.meta.url);
const fixture = fileURLToPath(new URL('tests/models/ara3d/AC20-FZK-Haus.ifc', repo));
const skip = existsSync(fixture) ? false : 'Run pnpm fixtures to fetch the independently authored FZK fixture';
const run = (script: string, args: string[]) => spawnSync(process.execPath, [
  fileURLToPath(new URL(`../dist/${script}.mjs`, import.meta.url)), ...args,
], { encoding: 'utf8', timeout: 60000 });

test('data and IDS recipes return real FZK results (DX4)', { skip }, () => {
  // Run the developer's workspace entry point with ordinary package resolution.
  const extracted = spawnSync('pnpm', ['--silent', '--dir', fileURLToPath(new URL('../', import.meta.url)), 'extract:dev', fixture], { encoding: 'utf8', timeout: 60000 });
  assert.equal(extracted.status, 0, extracted.stderr);
  const rows = JSON.parse(extracted.stdout) as { schema: string; doors: Array<{ GlobalId: string; Name: string }> };
  assert.equal(rows.schema, 'IFC4');
  assert.equal(rows.doors.length, 5);
  assert.equal(new Set(rows.doors.map(door => door.GlobalId)).size, 5);
  const validated = run('validate', [fixture, fileURLToPath(new URL('../doors-have-names.ids', import.meta.url))]);
  assert.equal(validated.status, 0, validated.stderr);
  const report = JSON.parse(validated.stdout) as { summary: { totalEntitiesChecked: number; failedSpecifications: number } };
  assert.equal(report.summary.totalEntitiesChecked, 5);
  assert.equal(report.summary.failedSpecifications, 0);
});

