/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    ['origin_tests', '::origins'],
    ['origin_completion_tests', '::origins::completion'],
    ['accept_stop_tests', '::accept_stop_tests'],
    ['affine_tests', '::affine_tests'],
    ['boolean_tests', '::boolean_tests'],
    ['boolean_origin_tests', '::boolean_tests::origins'],
    ['boolean_origin_protocol_tests', '::boolean_tests::origins::protocol'],
    ['finalization_stop_tests', '::finalization_stop_tests'],
    ['mapping_tests', '::mapping_tests'],
    ['mapping_contract_tests', '::mapping_contract'],
    ['mapping_input_tests', '::mapping_inputs'],
    ['mapping_origin_tests', '::mapping_inputs::origins'],
    ['mapping_origin_lifetime_tests', '::mapping_inputs::origins::lifetime'],
    ['mapping_direction_tests', '::mapping_inputs::directions'],
    ['mapping_direction_controls_tests', '::mapping_inputs::directions::controls'],
    ['mapping_certified_direction_tests', '::mapping_inputs::directions::certified'],
    ['mapping_omission_direction_tests', '::mapping_inputs::directions::omission'],
    ['operation_contract_tests', '::operation_contract'],
    ['type_map_tests', '::type_map_tests'],
    ['disk_tests', '::disk'],
    ['frame_tests', '::frames'],
    ['frame_origin_tests', '::frames::origins'],
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

// Execute the actual initial workflow dispatch on tiny Git histories. Reading
// the shell program is setup, not an assertion on its text: the observed result
// is its selected argv after real git diff calls, without invoking an oracle,
// Cargo, or a build. Each slice must retain its new types during inversion.
const b2aObserver = 'rust/geometry/src/program/retained/mapping_origin_tests.rs';
const b2bObserver = 'rust/geometry/src/program/retained/boolean_origin_tests.rs';
const b2cObserver = 'rust/geometry/src/program/retained/frame_origin_tests.rs';
for (const [boundary, files, observer = b2aObserver] of [
  ['B2c-only', [b2cObserver], b2cObserver],
  ['B2a+B2c', [b2aObserver, b2cObserver], b2cObserver],
  ['B2b+B2c', [b2bObserver, b2cObserver], b2cObserver],
  ['B2a+B2b+B2c', [b2aObserver, b2bObserver, b2cObserver], b2cObserver],
  ['B2a-only', [b2aObserver]],
  ['B2b-only', [b2bObserver], b2bObserver],
  ['B2a+B2b', [b2aObserver, b2bObserver]],
  ['stack', [b2aObserver,
    'rust/geometry/src/program/retained/origin_tests.rs',
    'rust/geometry/src/program/retained/mod.rs',
    'rust/geometry/src/program/mapping_retained.rs',
    'tests/evidence/j5-presentation/behaviour.oracle.patch']],
]) {
  test(`#7955: initial workflow dispatch selects source reporting at ${boundary} boundary`, () => {
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    const start = workflow.indexOf('          oracle_args=(--base origin/main --ci --json)');
    const end = workflow.indexOf('          node scripts/check-test-revert-oracle.mjs "${oracle_args[@]}"', start);
    if (start < 0 || end < 0) throw new Error('Cannot extract initial oracle dispatch');
    const selection = workflow.slice(start, end).replace(/^          /gm, '');
    const cwd = mkdtempSync(join(tmpdir(), 'ifc-b2a-dispatch-'));
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 10_000 });
    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Dispatch Fixture');
      git('config', 'user.email', 'dispatch@example.invalid');
      git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      for (const file of files) {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(join(cwd, file), '// dispatch fixture\n');
      }
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'slice');
      const selected = execFileSync('bash', ['-e', '-o', 'pipefail', '-c',
        `${selection}\nprintf '%s\\0' "\${oracle_args[@]}"`], { cwd, encoding: 'utf8', timeout: 10_000 });
      assert.deepEqual(selected.split('\0').filter(Boolean), [
        '--base', observer === b2aObserver ? '08769566858267aff3028f3f7c0e2870345ff73a'
          : '3190e3d88bee5e83a45ca155c62620c61b27456b', '--ci', '--json',
        '--mutation', observer === b2bObserver
          ? 'tests/evidence/retained-boolean-origin-b2b/predicate-report.oracle.patch'
          : observer === b2cObserver ? 'tests/evidence/retained-frame-origin-b2c/value-report.oracle.patch'
          : 'tests/evidence/retained-mapping-origin-b2a/occurrence-report.oracle.patch',
        '--test', observer,
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// #7955 S3: default-off modules remain present in library unit tests.
test('#7955: private S3 receipt/resource witnesses have exact library owners', () => {
  const inputs = [
    ['rust/geometry/src/document/retained_affine_tests.rs', 'ifc-lite-geometry', 'document::retained_affine::tests'],
    ['rust/geometry/src/document/retained_frames_tests.rs', 'ifc-lite-geometry', 'document::retained_frames::tests'],
    ['rust/geometry/src/program/retained/identity_tests.rs', 'ifc-lite-geometry', 'program::retained::identity::tests'],
    ['rust/geometry/src/program/retained/outcome_allocation_tests.rs', 'ifc-lite-geometry', 'program::retained::outcome::tests'],
    ['rust/geometry/src/resource/owned_tests.rs', 'ifc-lite-geometry', 'resource::owned::tests'],
    ['rust/geometry/src/resource/owned_detach_tests.rs', 'ifc-lite-geometry', 'resource::owned::tests::detach_tests'],
    ['rust/processing/src/element/model_context_retained_tests.rs', 'ifc-lite-processing', 'element::model_context::retained::tests'],
    ['rust/processing/src/element/model_context_snapshot_only_tests.rs', 'ifc-lite-processing', 'element::model_context::retained::tests::snapshot_only'],
  ];
  const { plans, unassigned, support } = planRuns(inputs.map(([file]) => file), root);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(support, []);
  assert.deepEqual(plans.map(({ file, crate, moduleFilter, runner }) => [file, crate, moduleFilter, runner.args]),
    inputs.map(([file, crate, module]) => [file, crate, module,
      ['test', '--no-fail-fast', '-p', crate, '--lib', '--', `${module}::`]]));
});
