/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Source the same initial dispatch helper as the workflow on tiny Git histories.
// Observe selected argv after real git diff calls, without invoking an oracle,
// Cargo, or a build. Each slice must retain its new types during inversion.
const dispatchHelper = join(root, 'scripts/lib/revert-oracle-initial-dispatch.sh');
function selectedOracleArgs(cwd, helper = dispatchHelper) {
  const selected = execFileSync('bash', ['-e', '-o', 'pipefail', '-c',
    'oracle_args=(--base origin/main --ci --json)\nif source "$1"; then matched=yes; else matched=no; fi\nprintf \'%s\\0\' "$matched" "${oracle_args[@]}"',
    'dispatch-fixture', helper], { cwd, encoding: 'utf8', timeout: 10_000 });
  const [matched, ...args] = selected.split('\0').filter(Boolean);
  return { matched, args };
}

const b2aObserver = 'rust/geometry/src/program/retained/mapping_origin_tests.rs';
const b2bObserver = 'rust/geometry/src/program/retained/boolean_origin_tests.rs';
const b2cObserver = 'rust/geometry/src/program/retained/frame_origin_tests.rs';
const cutCObserver = 'rust/processing/tests/retained_inspection_busy.rs';
for (const [boundary, files, observer = b2aObserver] of [
  ['Cut-C-only', [cutCObserver], cutCObserver],
  ['Cut-C+origins', [cutCObserver, b2aObserver, b2bObserver, b2cObserver], cutCObserver],
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
      const expected = [
        '--base', observer === cutCObserver ? '0b353d3294d4f813b3d9f16574442ff7cc19da58'
          : observer === b2aObserver ? '08769566858267aff3028f3f7c0e2870345ff73a'
          : '3190e3d88bee5e83a45ca155c62620c61b27456b', '--ci', '--json',
        '--mutation', observer === cutCObserver
          ? 'tests/evidence/retained-source-inspection-c/busy-report.oracle.patch'
          : observer === b2bObserver
          ? 'tests/evidence/retained-boolean-origin-b2b/predicate-report.oracle.patch'
          : observer === b2cObserver ? 'tests/evidence/retained-frame-origin-b2c/value-report.oracle.patch'
          : 'tests/evidence/retained-mapping-origin-b2a/occurrence-report.oracle.patch',
        '--test', observer,
      ];
      assert.deepEqual(selectedOracleArgs(cwd), { matched: 'yes', args: expected });

      // Disable each unique terminal branch in its own temporary helper.
      // The same behavioral assertion must reject both independent mutants.
      if (boundary === 'Cut-C-only' || boundary === 'B2b-only') {
        const mutant = join(cwd, 'mutated-dispatch.sh');
        copyFileSync(dispatchHelper, mutant);
        execFileSync('sed', ['-i',
          `s@grep -Fxq '${observer}'@grep -Fxq 'disabled/${observer}'@`, mutant],
        { cwd, stdio: 'pipe', timeout: 10_000 });
        assert.throws(() => assert.deepEqual(selectedOracleArgs(cwd, mutant),
          { matched: 'yes', args: expected }),
          { code: 'ERR_ASSERTION' });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('#7955: initial dispatch yields to later workflow clauses without a retained observer', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ifc-b2a-dispatch-empty-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd, timeout: 10_000 });
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Dispatch Fixture',
      '-c', 'user.email=dispatch@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
    { cwd, timeout: 10_000 });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
      { cwd, timeout: 10_000 });
    assert.deepEqual(selectedOracleArgs(cwd),
      { matched: 'no', args: ['--base', 'origin/main', '--ci', '--json'] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// #7955 S3: default-off modules remain present in library unit tests.
test('#7955: private S3 receipt/resource witnesses have exact library owners', () => {
  const inputs = [
    ['rust/geometry/src/document/retained_affine_tests.rs', 'ifc-lite-geometry', 'document::retained_affine::tests'],
    ['rust/geometry/src/document/retained_frames_tests.rs', 'ifc-lite-geometry', 'document::retained_frames::tests'],
    ['rust/geometry/src/program/retained/identity_tests.rs', 'ifc-lite-geometry', 'program::retained::identity::tests', ['wasm_source_capture']],
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
    inputs.map(([file, crate, module, features = []]) => [file, crate, module,
      ['test', '--no-fail-fast', '-p', crate, '--lib',
        ...(features.length > 0 ? ['--features', features.join(',')] : []), '--', `${module}::`]]));
});

function withIdentityOwnerFixture(attribute, { declareFeature = true, duplicateOwner = false } = {}, check) {
  const root = mkdtempSync(join(tmpdir(), 'ifc-identity-owner-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "identity-owner"\nversion = "0.1.0"\n' +
      'edition = "2021"\n[features]\ndefault = []\n' +
      (declareFeature ? 'wasm_source_capture = []\n' : ''));
    writeFileSync(join(root, 'src/lib.rs'), 'mod identity;\n');
    writeFileSync(join(root, 'src/identity.rs'), `${attribute}\n#[path = "identity_tests.rs"]\nmod tests;\n` +
      (duplicateOwner ? '#[cfg(test)]\n#[path = "identity_tests.rs"]\nmod other_tests;\n' : ''));
    writeFileSync(join(root, 'src/identity_tests.rs'), '#[test]\nfn observes() { assert!(true); }\n');
    check(planRuns(['src/identity_tests.rs'], root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('#7955: declared feature proves conditional identity owner active on every target', () => {
  withIdentityOwnerFixture('#[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")))]', {},
    ({ plans, unassigned }) => {
      assert.deepEqual(unassigned, []);
      assert.equal(plans.length, 1);
      assert.deepEqual(plans[0].runner.args,
        ['test', '--no-fail-fast', '-p', 'identity-owner', '--lib', '--features', 'wasm_source_capture',
          '--', 'identity::tests::']);
    });
});

test('#7955: unknown cfg, undeclared feature, and ambiguous identity owners remain unassigned', () => {
  for (const [attribute, options] of [
    ['#[cfg(all(test, unix))]', {}],
    ['#[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")))]',
      { declareFeature: false }],
    ['#[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")))]',
      { duplicateOwner: true }],
  ]) {
    withIdentityOwnerFixture(attribute, options, ({ plans, unassigned }) => {
      assert.deepEqual(plans, []);
      assert.equal(unassigned.length, 1);
      assert.match(unassigned[0].reason, /conditional or ambiguous/);
    });
  }
});

// #7955 Cut C: the actual planner must enable the default-off consumer.
test('#7955: inspection refusal observer runs with retained-runtime enabled', () => {
  const { plans, unassigned, support } = planRuns([cutCObserver], root);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(support, []);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].runner.family, 'cargo');
  assert.ok(plans[0].runner.args.includes('retained-runtime'));
  assert.ok(plans[0].runner.args.includes('--test'));
  assert.ok(plans[0].runner.args.includes('retained_inspection_busy'));
});
