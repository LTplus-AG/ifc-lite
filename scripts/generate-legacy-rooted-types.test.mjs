/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeLegacyRootedTypes } from './generate-legacy-rooted-types.mjs';

function table(rows) {
  return new Map(rows.map(([name, parent]) => [name, { name, parent }]));
}

test('computes legacy rootedness through ancestry and reports schema conflicts (#4203)', () => {
  const oldTables = [
    {
      schema: 'IFC2X3',
      table: table([
        ['IfcRoot', null],
        ['IfcProduct', 'IfcRoot'],
        ['IfcLegacyWall', 'IfcProduct'],
        ['IfcNonRooted', null],
        ['IfcCycleA', 'IfcCycleB'],
        ['IfcCycleB', 'IfcCycleA'],
        ['IfcConflict', 'IfcRoot'],
      ]),
    },
    {
      schema: 'IFC4',
      table: table([
        ['IfcRoot', null],
        ['IfcConflict', null],
      ]),
    },
  ];

  const rows = computeLegacyRootedTypes(oldTables, new Set(['IFCPRODUCT']));

  assert.equal(rows.has('IfcProduct'), false, 'IFC4X3-known names are excluded');
  assert.deepEqual(rows.get('IfcLegacyWall'), {
    rooted: true,
    sources: ['IFC2X3'],
    conflict: false,
  });
  assert.equal(rows.get('IfcNonRooted').rooted, false);
  assert.equal(rows.get('IfcCycleA').rooted, false, 'cycles must terminate as non-rooted');
  assert.deepEqual(rows.get('IfcConflict'), {
    rooted: true,
    sources: ['IFC2X3', 'IFC4'],
    conflict: true,
  });
});

test('the committed Rust table matches the production generator (#4203)', () => {
  const script = fileURLToPath(new URL('./generate-legacy-rooted-types.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /54 rooted legacy entities, 0 conflicts/);
});
