/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Run after root Turbo builds/tests: execute the real compiled CLI locally.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url)), 'doctor', '--json'],
  { encoding: 'utf8', timeout: 20000 });
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
const report = JSON.parse(result.stdout);
assert.equal(report.wasm.code, 'VALID_WASM_BINARY');
assert.ok(report.wasm.byteLength > 8, 'Evidence must use the real IFC WASM artifact');
writeFileSync(new URL('./installation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
