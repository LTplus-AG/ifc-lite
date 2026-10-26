/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { planRuns } from './revert-oracle-plan-runs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('#7955: retained witnesses resolve through the facade path to exact library modules', () => {
  // Physical paths differ from Rust module identities. In particular, the
  // references module is nested under structure, and frames is plural.
  // Exercise the planner on its real input tree, not source-text assertions
  // or a hand-built runner that could silently bypass ownership checks.
  const modules = [
    ['admission_tests', '::admission'],
    ['disk_tests', '::disk'],
    ['frame_tests', '::frames'],
    ['obligations_tests', '::obligations'],
    ['protocol_tests', '::protocol'],
    ['reference_tests', '::structure::references'],
    ['structure_tests', '::structure'],
    ['tests', ''],
  ];
  const files = modules.map(([file]) => `rust/geometry/src/program/retained/${file}.rs`);
  const { plans, unassigned, support } = planRuns(files, root);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(support, []);
  assert.deepEqual(plans.map(({ file, moduleFilter, runner }) => ({ file, moduleFilter, runner })),
    modules.map(([, suffix], index) => {
      const moduleFilter = `program::inner::retained_program::tests${suffix}`;
      return {
        file: files[index],
        moduleFilter,
        runner: {
          family: 'cargo',
          bin: 'cargo',
          args: ['test', '--no-fail-fast', '-p', 'ifc-lite-geometry', '--lib', '--', `${moduleFilter}::`],
        },
      };
    }));
});
