/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

it('#10888 stopping a still-referenced tap releases its acknowledged CPU arrays', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
    '--import', './src/test/vite-module-hooks.mjs', '--input-type=module', '-e',
    "const m = await import('./src/lib/geometry-backing/__fixtures__/stopped-tap-gc.ts'); await m.stoppedTapGc();"],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
});
