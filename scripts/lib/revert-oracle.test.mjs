/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the revert oracle's pure logic.
 *
 * The runner-output fixtures below are VERBATIM captures from this repo's
 * actual runners (node 22 `tsx --test`, vitest 4, cargo), taken by deliberately
 * breaking a module load and deliberately breaking an assertion and recording
 * what each printed. They are not invented, because the whole tool rests on
 * telling those two apart and a hand-written approximation of the output would
 * test the approximation.
 *
 * Run: node --test scripts/lib/revert-oracle.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPath,
  classifyDiff,
  parseNameStatus,
  detectRunner,
  extractNodeFlags,
  cargoRunner,
  rootScriptsRunner,
  aggregate,
  parseRunnerOutput,
  hasLoadError,
  verdict,
  PASS,
  ASSERTION_FAILURE,
  LOAD_FAILURE,
  NO_TESTS,
  RUNNER_MISSING,
  UNPARSEABLE,
  OBSERVED,
  UNOBSERVED,
  INCONCLUSIVE,
  BASELINE_BROKEN,
} from './revert-oracle.mjs';

// ---------------------------------------------------------------------------
// Fixtures: real runner output
// ---------------------------------------------------------------------------

/** node --test, one assertion failed and one passed. Captured 2026-08-21. */
const NODE_ASSERTION_FAILURE = `TAP version 13
# Subtest: adds
not ok 1 - adds
  ---
  duration_ms: 1.229
  location: '/w/.tmp-probe/assert.test.ts:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 2
  actual: 1
  operator: 'strictEqual'
  ...
# Subtest: other
ok 2 - other
  ---
  duration_ms: 0.136959
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 836.277875
`;

/**
 * node --test, the test file failed to IMPORT because the production revert
 * removed the export it names. THE TRAP: `# fail 1` and a non-zero exit, yet
 * zero assertions ran. Captured 2026-08-21.
 */
const NODE_LOAD_FAILURE = `TAP version 13
# /w/.tmp-probe/load.test.ts:3
# import { missing } from './mod.ts';
#          ^
# SyntaxError: The requested module './mod.ts' does not provide an export named 'missing'
#     at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)
# Node.js v22.13.1
# Subtest: /w/.tmp-probe/load.test.ts
not ok 1 - /w/.tmp-probe/load.test.ts
  ---
  duration_ms: 201.097792
  location: '/w/.tmp-probe/load.test.ts:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 204.909917
`;

const NODE_ALL_PASS = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.3
  ...
1..1
# tests 197
# suites 12
# pass 197
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1204.9
`;

const NODE_ZERO_TESTS = `TAP version 13
1..0
# tests 0
# suites 0
# pass 0
# fail 0
# duration_ms 12.1
`;

/** vitest 4, assertion failure. Captured 2026-08-21. */
const VITEST_ASSERTION_FAILURE = ` ❯ src/__probe/a.test.ts (2 tests | 1 failed) 3ms
     × fails 2ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__probe/a.test.ts > p > fails
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  15:24:06
   Duration  89ms
`;

/** vitest 4, collection error — the suite never produced a test. */
const VITEST_LOAD_FAILURE = ` RUN  v4.1.10 /w/packages/sandbox

 ❯ src/__probe/b.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__probe/b.test.ts [ src/__probe/b.test.ts ]
Error: Failed to resolve entry for package "@ifc-lite/sdk". The package may have incorrect main/module/exports specified in its package.json.

 Test Files  1 failed (1)
      Tests  no tests
   Start at  15:24:09
   Duration  123ms
`;

const VITEST_ALL_PASS = ` ✓ src/bridge-marshal.test.ts (12 tests) 21ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  15:30:00
   Duration  410ms
`;

const VITEST_NO_FILES = `
 include: **/*.{test,spec}.?(c|m)[jt]s?(x)

No test files found, exiting with code 1
`;

const CARGO_PASS = `running 41 tests
test geom::tests::planar ... ok

test result: ok. 41 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
`;

const CARGO_ASSERTION_FAILURE = `running 41 tests
test geom::tests::planar ... FAILED

failures:

---- geom::tests::planar stdout ----
thread 'geom::tests::planar' panicked at src/geom.rs:88:9:
assertion \`left == right\` failed

test result: FAILED. 40 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
`;

/** The Rust form of the trap: the revert took `#[cfg(test)] mod tests` with it. */
const CARGO_COMPILE_ERROR = `   Compiling ifc-lite-geom v0.1.0
error[E0432]: unresolved import \`crate::walk::visit_typed\`
 --> src/geom.rs:12:5
  |
12| use crate::walk::visit_typed;
  |     ^^^^^^^^^^^^^^^^^^^^^^^^ no \`visit_typed\` in \`walk\`

error: aborting due to 1 previous error
error: could not compile \`ifc-lite-geom\` (lib test) due to 1 previous error
`;

/**
 * vitest 4, THE VITE FORM OF THE TRAP. Unlike node's ESM loader, which throws
 * at instantiation when a named export is missing, Vite binds the import to
 * `undefined`. The module therefore LOADS, the test body runs, and vitest
 * prints an ordinary `Failed Tests` banner — the same shape as a real RED.
 * Not one assertion was actually evaluated against the subject.
 *
 * Captured 2026-08-22 by running vitest 4.1.10 against a module that no longer
 * exports `computeThing`. Verbatim except that the absolute cwd printed on the
 * `RUN` line was replaced with `/w/.tmp-probe`.
 */
const VITEST_REMOVED_EXPORT_DEAD_BINDING = `
 RUN  v4.1.10 /w/.tmp-probe

 ❯ src/compute-thing.test.ts (3 tests | 3 failed) 2ms
     × doubles 1ms
     × handles zero 0ms
     × handles negatives 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/compute-thing.test.ts > computeThing > doubles
TypeError: computeThing is not a function
 ❯ src/compute-thing.test.ts:6:12
      4| describe('computeThing', () => {
      5|   it('doubles', () => {
      6|     expect(computeThing(2)).toBe(4);
       |            ^
      7|   });
      8|   it('handles zero', () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  src/compute-thing.test.ts > computeThing > handles zero
TypeError: computeThing is not a function
 ❯ src/compute-thing.test.ts:9:12
      7|   });
      8|   it('handles zero', () => {
      9|     expect(computeThing(0)).toBe(0);
       |            ^
     10|   });
     11|   it('handles negatives', () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  src/compute-thing.test.ts > computeThing > handles negatives
TypeError: computeThing is not a function
 ❯ src/compute-thing.test.ts:12:12
     10|   });
     11|   it('handles negatives', () => {
     12|     expect(computeThing(-3)).toBe(-6);
       |            ^
     13|   });
     14| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯


 Test Files  1 failed (1)
      Tests  3 failed (3)
   Start at  08:14:00
   Duration  94ms (transform 10ms, setup 0ms, import 15ms, tests 2ms, environment 0ms)

`;
/**
 * The same dead binding, one word different, because the removed export was a
 * class: `is not a constructor` rather than `is not a function`. Captured the
 * same way and on the same day as the fixture above.
 */
const VITEST_REMOVED_CLASS_DEAD_BINDING = `
 RUN  v4.1.10 /w/.tmp-probe

 ❯ src/klass.test.ts (1 test | 1 failed) 2ms
     × constructs 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/klass.test.ts > Mesh > constructs
TypeError: Mesh is not a constructor
 ❯ src/klass.test.ts:6:12
      4| describe('Mesh', () => {
      5|   it('constructs', () => {
      6|     expect(new Mesh().id).toBe(1);
       |            ^
      7|   });
      8| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  08:15:02
   Duration  84ms (transform 8ms, setup 0ms, import 13ms, tests 2ms, environment 0ms)

`;
/**
 * The counter-example that keeps the pattern above honest: a GENUINE assertion
 * failure whose message is also a TypeError, thrown from product code
 * (`src/geom.ts`), not from a dead import binding. The test really did observe
 * the bug, so this must stay an assertion failure. Captured the same way.
 */
const VITEST_GENUINE_TYPEERROR = `
 RUN  v4.1.10 /w/.tmp-probe

 ❯ src/geom.test.ts (2 tests | 1 failed) 2ms
     × counts points 1ms
     ✓ measures width 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/geom.test.ts > geom > counts points
TypeError: Cannot read properties of undefined (reading 'length')
 ❯ boundsOf src/geom.ts:4:18
      2|   // Genuine product bug: points is not defaulted, so this throws a Ty…
      3|   // from PRODUCT code, not from a dead import binding.
      4|   return points!.length;
       |                  ^
      5| }
      6|
 ❯ src/geom.test.ts:6:12

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  08:15:35
   Duration  95ms (transform 18ms, setup 0ms, import 23ms, tests 2ms, environment 0ms)

`;
/**
 * vitest 4, a collection error whose text matches NO import/compile pattern
 * (a bare `throw new Error('boom')` at module top level), running alongside a
 * file that passed. `Tests  2 passed (2)` is the only summary line, so the
 * STRUCTURAL `Failed Suites` signal is the only thing standing between this
 * run and a catastrophic PASS. Captured the same way.
 */
const VITEST_COLLECTION_THROW_WITH_PASSES = `
 RUN  v4.1.10 /w/.tmp-probe

 ❯ src/boom.test.ts (0 test)
 ✓ src/ok.test.ts (2 tests) 1ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/boom.test.ts [ src/boom.test.ts ]
Error: boom
 ❯ src/boom.test.ts:3:7
      1| import { describe, it, expect } from 'vitest';
      2|
      3| throw new Error('boom');
       |       ^
      4|
      5| describe('never collected', () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 1 passed (2)
      Tests  2 passed (2)
   Start at  08:15:03
   Duration  86ms (transform 21ms, setup 0ms, import 17ms, tests 1ms, environment 0ms)

`;


// ---------------------------------------------------------------------------
// classifyPath / classifyDiff
// ---------------------------------------------------------------------------

test('classifyPath: production sources', () => {
  assert.equal(classifyPath('packages/renderer/src/device.ts'), 'production');
  assert.equal(classifyPath('apps/viewer/src/hooks/useSymbolicAnnotations.ts'), 'production');
  assert.equal(classifyPath('crates/ifc-lite-geom/src/walk.rs'), 'production');
  assert.equal(classifyPath('packages/core/package.json'), 'production');
});

test('classifyPath: test sources', () => {
  assert.equal(classifyPath('packages/renderer/src/frame-timing.test.ts'), 'test');
  assert.equal(classifyPath('apps/viewer/src/hooks/x.retryStorm.test.ts'), 'test');
  assert.equal(classifyPath('packages/core/src/a.spec.tsx'), 'test');
  assert.equal(classifyPath('scripts/lib/revert-oracle.test.mjs'), 'test');
  assert.equal(classifyPath('tests/api/query.test.ts'), 'test');
  assert.equal(classifyPath('packages/core/src/__tests__/helper.ts'), 'test');
  assert.equal(classifyPath('packages/core/src/__snapshots__/a.snap'), 'test');
});

test('classifyPath: a `test-utils.ts` is production, not a test', () => {
  // Distinct subject from the `test/` SEGMENT case below: a hyphenated
  // filename must not be swallowed by the directory rule.
  assert.equal(classifyPath('packages/core/src/test-utils.ts'), 'production');
  assert.equal(classifyPath('packages/core/src/testing.ts'), 'production');
});

test('classifyPath: ignored non-code', () => {
  assert.equal(classifyPath('.changeset/renderer-frame-timing.md'), 'ignored');
  assert.equal(classifyPath('README.md'), 'ignored');
  assert.equal(classifyPath('pnpm-lock.yaml'), 'ignored');
  assert.equal(classifyPath('.github/workflows/test.yml'), 'ignored');
  assert.equal(classifyPath('docs/guide/x.ts'), 'ignored');
});

test('classifyDiff splits a real branch shape and never puts a test in production', () => {
  const entries = parseNameStatus(
    [
      'A\t.changeset/renderer-frame-timing.md',
      'M\tpackages/renderer/src/device.ts',
      'A\tpackages/renderer/src/frame-timing.ts',
      'A\tpackages/renderer/src/frame-timing.test.ts',
    ].join('\n'),
  );
  const { production, test: tests, ignored, warnings } = classifyDiff(entries);
  assert.deepEqual(
    production.map((e) => e.path),
    ['packages/renderer/src/device.ts', 'packages/renderer/src/frame-timing.ts'],
  );
  assert.deepEqual(tests.map((e) => e.path), ['packages/renderer/src/frame-timing.test.ts']);
  assert.deepEqual(ignored.map((e) => e.path), ['.changeset/renderer-frame-timing.md']);
  assert.deepEqual(warnings, []);
});

test('classifyDiff warns that a Rust revert takes `#[cfg(test)] mod tests` with it', () => {
  const { warnings } = classifyDiff(parseNameStatus('M\tcrates/ifc-lite-geom/src/walk.rs'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cfg\(test\)/);
});

test('parseNameStatus takes the NEW path of a rename', () => {
  const entries = parseNameStatus('R096\tpackages/a/src/old.ts\tpackages/a/src/new.ts');
  assert.deepEqual(entries, [{ status: 'R', path: 'packages/a/src/new.ts' }]);
});

test('parseNameStatus on empty input yields no entries', () => {
  assert.deepEqual(parseNameStatus(''), []);
  assert.deepEqual(parseNameStatus('\n\n'), []);
});

// ---------------------------------------------------------------------------
// detectRunner
// ---------------------------------------------------------------------------

test('detectRunner: vitest packages', () => {
  const r = detectRunner('vitest run', ['src/a.test.ts']);
  assert.equal(r.family, 'vitest');
  assert.equal(r.bin, 'vitest');
  assert.deepEqual(r.args, ['run', '--reporter=default', 'src/a.test.ts']);
});

test('detectRunner: --passWithNoTests is NOT forwarded, so an empty run stays an error', () => {
  const r = detectRunner('vitest run --passWithNoTests', ['src/a.test.ts']);
  assert.ok(!r.args.includes('--passWithNoTests'));
});

test('detectRunner: packages/renderer runs tsx --test with an explicit file list', () => {
  // The package script globs `src/*.test.ts` (top level only). We replace the
  // glob rather than reuse it, so a nested test file is still reachable.
  const r = detectRunner('tsx --test src/*.test.ts', ['src/frame-timing.test.ts']);
  assert.equal(r.family, 'node-test');
  assert.equal(r.bin, 'tsx');
  assert.deepEqual(r.args, ['--test', 'src/frame-timing.test.ts']);
});

test('detectRunner: apps/viewer keeps --import and --test-concurrency, which it cannot run without', () => {
  const script =
    "tsx --import ./src/test/vite-module-hooks.mjs --test --test-concurrency=1 $(find src -type f -name '*.test.ts' | sort)";
  const r = detectRunner(script, ['src/hooks/x.test.ts']);
  assert.equal(r.family, 'node-test');
  assert.equal(r.bin, 'tsx');
  assert.deepEqual(r.args, [
    '--import',
    './src/test/vite-module-hooks.mjs',
    '--test-concurrency=1',
    '--test',
    'src/hooks/x.test.ts',
  ]);
});

test('detectRunner: plain `node --test` package uses node, not tsx', () => {
  const r = detectRunner('node --test test/*.test.mjs', ['test/a.test.mjs']);
  assert.equal(r.bin, 'node');
  assert.deepEqual(r.args, ['--test', 'test/a.test.mjs']);
});

test('detectRunner: a package with no usable test script returns null, never a guess', () => {
  assert.equal(detectRunner(undefined, ['a.test.ts']), null);
  assert.equal(detectRunner('', ['a.test.ts']), null);
  assert.equal(detectRunner('echo "no tests here"', ['a.test.ts']), null);
});

test('extractNodeFlags keeps only flags, dropping the script\'s file expression', () => {
  assert.deepEqual(extractNodeFlags('tsx --tsconfig tests/tsconfig.json --test "tests/**/*.test.ts"'), [
    '--tsconfig',
    'tests/tsconfig.json',
  ]);
});

test('rootScriptsRunner: scripts/**.test.mjs run the way CI runs them, not via `turbo test`', () => {
  assert.deepEqual(rootScriptsRunner(['scripts/lib/revert-oracle.test.mjs']), {
    family: 'node-test',
    bin: 'node',
    args: ['--test', 'scripts/lib/revert-oracle.test.mjs'],
  });
});

test('rootScriptsRunner refuses anything it would have to guess about', () => {
  assert.equal(rootScriptsRunner([]), null);
  assert.equal(rootScriptsRunner(['scripts/a.test.ts']), null, 'a .ts needs a loader');
  assert.equal(rootScriptsRunner(['packages/core/src/a.test.mjs']), null, 'not under scripts/');
  assert.equal(
    rootScriptsRunner(['scripts/a.test.mjs', 'packages/core/src/b.test.mjs']),
    null,
    'a mixed batch is not all-scripts',
  );
});

test('cargoRunner targets one crate and refuses an unnamed one', () => {
  assert.deepEqual(cargoRunner('ifc-lite-geom'), {
    family: 'cargo',
    bin: 'cargo',
    args: ['test', '-p', 'ifc-lite-geom'],
  });
  assert.equal(cargoRunner(null), null);
});

// ---------------------------------------------------------------------------
// parseRunnerOutput — the discriminator
// ---------------------------------------------------------------------------

test('node --test: an assertion failure is an assertion failure', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: NODE_ASSERTION_FAILURE, stderr: '', exitCode: 1 });
  assert.equal(r.kind, ASSERTION_FAILURE);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.total, 2);
});

test('THE TRAP: node --test import failure is NOT read as an assertion failure', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: NODE_LOAD_FAILURE, stderr: '', exitCode: 1 });
  assert.equal(r.kind, LOAD_FAILURE);
  // Same `# fail 1` and same non-zero exit as the assertion fixture above --
  // only the output text separates them.
  assert.equal(r.failed, 1);
  assert.match(r.evidence[0], /does not provide an export named/);
});

test('node --test: all green', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: NODE_ALL_PASS, stderr: '', exitCode: 0 });
  assert.equal(r.kind, PASS);
  assert.equal(r.total, 197);
  assert.equal(r.passed, 197);
});

test('node --test: zero collected tests is never a pass', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: NODE_ZERO_TESTS, stderr: '', exitCode: 0 });
  assert.equal(r.kind, NO_TESTS);
});

test('node --test: output with no summary at all is UNPARSEABLE, not a pass', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: 'TAP version 13\n', stderr: '', exitCode: 0 });
  assert.equal(r.kind, UNPARSEABLE);
});

test('vitest: an assertion failure is an assertion failure', () => {
  const r = parseRunnerOutput({ family: 'vitest', stdout: VITEST_ASSERTION_FAILURE, stderr: '', exitCode: 1 });
  assert.equal(r.kind, ASSERTION_FAILURE);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.total, 2);
});

test('THE TRAP: vitest `Failed Suites` is a collection error, not a RED', () => {
  const r = parseRunnerOutput({ family: 'vitest', stdout: VITEST_LOAD_FAILURE, stderr: '', exitCode: 1 });
  assert.equal(r.kind, LOAD_FAILURE);
  assert.match(r.evidence[0], /Failed Suite|Failed to resolve/);
});

test('vitest: all green', () => {
  const r = parseRunnerOutput({ family: 'vitest', stdout: VITEST_ALL_PASS, stderr: '', exitCode: 0 });
  assert.equal(r.kind, PASS);
  assert.equal(r.total, 12);
});

test('vitest: "No test files found" is NO_TESTS, not a pass', () => {
  const r = parseRunnerOutput({ family: 'vitest', stdout: VITEST_NO_FILES, stderr: '', exitCode: 1 });
  assert.equal(r.kind, NO_TESTS);
});

test('THE TRAP, VITE FORM: a removed export bound to undefined is NOT an assertion failure', () => {
  const r = parseRunnerOutput({
    family: 'vitest',
    stdout: VITEST_REMOVED_EXPORT_DEAD_BINDING,
    stderr: '',
    exitCode: 1,
  });
  // Vitest reported `Failed Tests 3` and exit 1 — indistinguishable from a real
  // RED by every structural signal. Only the error text separates them.
  assert.equal(r.kind, LOAD_FAILURE);
  assert.equal(r.failed, 3);
  assert.match(r.evidence[0], /is not a function/);
  const v = verdict({
    baseline: { kind: PASS, passed: 3, failed: 0, total: 3, evidence: [] },
    reverted: r,
  });
  assert.equal(v.verdict, INCONCLUSIVE, 'a dead binding must never certify the change');
  assert.notEqual(v.exitCode, 0);
});

test('THE TRAP, VITE FORM: a removed exported CLASS reads the same way', () => {
  const r = parseRunnerOutput({
    family: 'vitest',
    stdout: VITEST_REMOVED_CLASS_DEAD_BINDING,
    stderr: '',
    exitCode: 1,
  });
  assert.equal(r.kind, LOAD_FAILURE);
  assert.match(r.evidence[0], /is not a constructor/);
});

test('a GENUINE TypeError thrown by product code stays an assertion failure', () => {
  // The opposite error to the one above, and the cost of getting it wrong is
  // real coverage reported as INCONCLUSIVE. The pattern is deliberately spelt
  // `is not a function`/`is not a constructor` rather than a blanket TypeError.
  const r = parseRunnerOutput({
    family: 'vitest',
    stdout: VITEST_GENUINE_TYPEERROR,
    stderr: '',
    exitCode: 1,
  });
  assert.equal(r.kind, ASSERTION_FAILURE);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.total, 2);
  assert.equal(hasLoadError(VITEST_GENUINE_TYPEERROR), false);
});

test('vitest: the STRUCTURAL Failed Suites signal catches a collection error no text pattern matches', () => {
  // No import/compile string appears anywhere in this output, and the only
  // summary line is `Tests  2 passed (2)`. Without the `Failed Suites` check
  // the run would be read as a clean PASS.
  assert.equal(hasLoadError(VITEST_COLLECTION_THROW_WITH_PASSES), false);
  const r = parseRunnerOutput({
    family: 'vitest',
    stdout: VITEST_COLLECTION_THROW_WITH_PASSES,
    stderr: '',
    exitCode: 1,
  });
  assert.equal(r.kind, LOAD_FAILURE);
  assert.match(r.evidence[0], /Failed Suite/);
});

test('cargo: pass, assertion failure, and compile failure are three distinct kinds', () => {
  assert.equal(parseRunnerOutput({ family: 'cargo', stdout: CARGO_PASS, stderr: '', exitCode: 0 }).kind, PASS);
  const failed = parseRunnerOutput({ family: 'cargo', stdout: CARGO_ASSERTION_FAILURE, stderr: '', exitCode: 101 });
  assert.equal(failed.kind, ASSERTION_FAILURE);
  assert.equal(failed.failed, 1);
  assert.equal(failed.passed, 40);
  const compile = parseRunnerOutput({ family: 'cargo', stdout: '', stderr: CARGO_COMPILE_ERROR, exitCode: 101 });
  assert.equal(compile.kind, LOAD_FAILURE);
});

test('a missing runner binary is RUNNER_MISSING, never a pass', () => {
  const r = parseRunnerOutput({
    family: 'vitest',
    stdout: '',
    stderr: 'sh: vitest: command not found',
    exitCode: 127,
  });
  assert.equal(r.kind, RUNNER_MISSING);
});

test('a spawn error is RUNNER_MISSING, never a pass', () => {
  const r = parseRunnerOutput({ family: 'vitest', stdout: '', stderr: '', exitCode: null, spawnError: 'ENOENT' });
  assert.equal(r.kind, RUNNER_MISSING);
});

test('an unknown runner family is UNPARSEABLE, never a pass', () => {
  const r = parseRunnerOutput({ family: 'jest', stdout: 'Tests: 4 passed', stderr: '', exitCode: 0 });
  assert.equal(r.kind, UNPARSEABLE);
});

test('a load error outranks green assertions elsewhere in the same run', () => {
  // Two files: one produced honest passes, the other never loaded. The run as a
  // whole tells us nothing.
  const mixed = `${VITEST_ASSERTION_FAILURE}\n${VITEST_LOAD_FAILURE}`;
  assert.equal(parseRunnerOutput({ family: 'vitest', stdout: mixed, stderr: '', exitCode: 1 }).kind, LOAD_FAILURE);
});

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

const green = { kind: PASS, passed: 10, failed: 0, total: 10, evidence: [] };

test('verdict: revert turns assertions red -> OBSERVED, exit 0', () => {
  const v = verdict({
    baseline: green,
    reverted: { kind: ASSERTION_FAILURE, passed: 7, failed: 3, total: 10, evidence: [] },
  });
  assert.equal(v.verdict, OBSERVED);
  assert.equal(v.exitCode, 0);
});

test('verdict: revert changes nothing -> UNOBSERVED, exit non-zero', () => {
  const v = verdict({ baseline: green, reverted: { ...green } });
  assert.equal(v.verdict, UNOBSERVED);
  assert.notEqual(v.exitCode, 0);
  assert.match(v.reason, /still PASS/);
});

test('verdict: THE TRAP -> INCONCLUSIVE, and it must not read as OBSERVED', () => {
  const v = verdict({
    baseline: green,
    reverted: {
      kind: LOAD_FAILURE,
      passed: 0,
      failed: 1,
      total: 1,
      evidence: ['does not provide an export named __resetCacheForTests'],
    },
  });
  assert.equal(v.verdict, INCONCLUSIVE);
  assert.notEqual(v.exitCode, 0);
  assert.match(v.reason, /NOT evidence the change is covered/);
  assert.match(v.advice, /--mutation/);
});

test('verdict: tests that VANISH under revert are INCONCLUSIVE even when others fail honestly', () => {
  const v = verdict({
    baseline: green,
    reverted: { kind: ASSERTION_FAILURE, passed: 1, failed: 2, total: 3, evidence: [] },
  });
  assert.equal(v.verdict, INCONCLUSIVE);
  assert.match(v.reason, /FEWER tests/);
});

test('verdict: a red baseline is BASELINE-BROKEN, never a result about the change', () => {
  const v = verdict({
    baseline: { kind: ASSERTION_FAILURE, passed: 9, failed: 1, total: 10, evidence: [] },
    reverted: { ...green },
  });
  assert.equal(v.verdict, BASELINE_BROKEN);
  assert.notEqual(v.exitCode, 0);
});

test('verdict: a baseline that collected nothing is INCONCLUSIVE, not OBSERVED', () => {
  const v = verdict({
    baseline: { kind: PASS, passed: 0, failed: 0, total: 0, evidence: [] },
    reverted: { kind: PASS, passed: 0, failed: 0, total: 0, evidence: [] },
  });
  assert.equal(v.verdict, INCONCLUSIVE);
  assert.notEqual(v.exitCode, 0);
});

test('verdict: every non-OBSERVED outcome exits non-zero', () => {
  for (const kind of [LOAD_FAILURE, NO_TESTS, RUNNER_MISSING, UNPARSEABLE, PASS]) {
    const v = verdict({ baseline: green, reverted: { kind, passed: 10, failed: 0, total: 10, evidence: ['x'] } });
    assert.notEqual(v.exitCode, 0, `${kind} must not exit 0`);
  }
});

test('verdict: a missing run never reports clean', () => {
  assert.notEqual(verdict({ baseline: null, reverted: green }).exitCode, 0);
  assert.notEqual(verdict({ baseline: green, reverted: null }).exitCode, 0);
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

test('a load failure records BOTH the import error text and the structural signal', () => {
  const r = parseRunnerOutput({ family: 'node-test', stdout: NODE_LOAD_FAILURE, stderr: '', exitCode: 1 });
  assert.equal(r.evidence.length, 2);
  assert.match(r.evidence[0], /does not provide an export named/);
  assert.match(r.evidence[1], /failed the whole FILE/);
});

test('aggregate: one package that failed to load poisons two green ones', () => {
  const a = aggregate([
    { kind: PASS, passed: 5, failed: 0, total: 5, evidence: [] },
    { kind: PASS, passed: 3, failed: 0, total: 3, evidence: [] },
    { kind: LOAD_FAILURE, passed: 0, failed: 1, total: 1, evidence: ['SyntaxError: x'] },
  ]);
  assert.equal(a.kind, LOAD_FAILURE);
  assert.equal(a.total, 9);
});

test('aggregate: an assertion failure alongside passes stays an assertion failure', () => {
  const a = aggregate([
    { kind: PASS, passed: 5, failed: 0, total: 5, evidence: [] },
    { kind: ASSERTION_FAILURE, passed: 2, failed: 1, total: 3, evidence: [] },
  ]);
  assert.equal(a.kind, ASSERTION_FAILURE);
  assert.equal(a.failed, 1);
  assert.equal(a.total, 8);
});

test('aggregate: zero packages is UNPARSEABLE, never a pass', () => {
  assert.equal(aggregate([]).kind, UNPARSEABLE);
  assert.equal(aggregate(undefined).kind, UNPARSEABLE);
});
