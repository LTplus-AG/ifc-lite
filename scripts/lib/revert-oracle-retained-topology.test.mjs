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
    ['outcome_tests', '::outcome_tests'],
    ['accept_stop_tests', '::accept_stop_tests'],
    ['affine_tests', '::affine_tests'],
    ['boolean_tests', '::boolean_tests'],
    ['finalization_stop_tests', '::finalization_stop_tests'],
    ['mapping_tests', '::mapping_tests'],
    ['mapping_contract_tests', '::mapping_contract'],
    ['mapping_input_tests', '::mapping_inputs'],
    ['mapping_direction_tests', '::mapping_inputs::directions'],
    ['mapping_direction_controls_tests', '::mapping_inputs::directions::controls'],
    ['mapping_certified_direction_tests', '::mapping_inputs::directions::certified'],
    ['mapping_omission_direction_tests', '::mapping_inputs::directions::omission'],
    ['operation_contract_tests', '::operation_contract'],
    ['type_map_tests', '::type_map_tests'],
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

// #7955 S3: default-off modules remain present in library unit tests.
test('#7955: private S3 receipt/resource witnesses have exact library owners', () => {
  const inputs = [
    ['rust/geometry/src/document/retained_affine_tests.rs', 'ifc-lite-geometry', 'document::retained_affine::tests'],
    ['rust/geometry/src/document/retained_frames_tests.rs', 'ifc-lite-geometry', 'document::retained_frames::tests'],
    ['rust/geometry/src/program/retained/outcome_allocation_tests.rs', 'ifc-lite-geometry', 'program::retained::outcome::tests'],
    ['rust/geometry/src/resource/owned_tests.rs', 'ifc-lite-geometry', 'resource::owned::tests'],
    ['rust/processing/src/element/model_context_retained_tests.rs', 'ifc-lite-processing', 'element::model_context::retained::tests'],
  ];
  const { plans, unassigned, support } = planRuns(inputs.map(([file]) => file), root);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(support, []);
  assert.deepEqual(plans.map(({ file, crate, moduleFilter, runner }) => [file, crate, moduleFilter, runner.args]),
    inputs.map(([file, crate, module]) => [file, crate, module,
      ['test', '--no-fail-fast', '-p', crate, '--lib', '--', `${module}::`]]));
});
