import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pythonTestOwner, pythonRunner, parsePython, PYTEST_MISSING_PATTERN } from './revert-oracle-python.mjs';

// ---------------------------------------------------------------------------
// pythonTestOwner: mirrors revert-oracle-cargo.test.mjs's Cargo.toml walk,
// but for a `requirements.lock` (this repo's real tools/ifcopenshell_reference
// shape) or one of the other recognised Python project markers.
// ---------------------------------------------------------------------------

test('#4050: a Python test walks up to the nearest project marker; outside the root resolves to nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-python-'));
  try {
    const dir = join(root, 'tools', 'ifcopenshell_reference');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'requirements.lock'), 'ifcopenshell==0.8.0\n');
    writeFileSync(join(dir, 'test_harness.py'), 'def test_ok():\n    assert True\n');
    assert.deepEqual(pythonTestOwner(join(dir, 'test_harness.py'), root), { dir });
    assert.deepEqual(pythonTestOwner(join(dir, 'test_validate_export.py'), root), { dir });
    // No marker anywhere above this file: refuse rather than guess an owner,
    // the same refusal cargoTestOwner applies to a crate-less `.rs` file.
    assert.equal(pythonTestOwner(join(root, 'loose', 'test_x.py'), root), null);
    assert.equal(pythonTestOwner(join(root, '..', 'test_outside.py'), root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pythonTestOwner: pyproject.toml and setup.py are also recognised markers', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-python-'));
  try {
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'pyproject.toml'), '[project]\nname = "a"\n');
    writeFileSync(join(b, 'setup.py'), '');
    assert.deepEqual(pythonTestOwner(join(a, 'sub', 'test_a.py'), root), { dir: a });
    assert.deepEqual(pythonTestOwner(join(b, 'test_b.py'), root), { dir: b });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pythonRunner
// ---------------------------------------------------------------------------

test('pythonRunner: runs python3 -B -m pytest over the explicit file list, quietly, without colour, and without writing __pycache__', () => {
  assert.deepEqual(pythonRunner(['test_harness.py', 'test_validate_export.py']), {
    family: 'python',
    bin: 'python3',
    args: ['-B', '-m', 'pytest', '-q', '--color=no', 'test_harness.py', 'test_validate_export.py'],
  });
  assert.equal(pythonRunner([]), null);
});

// ---------------------------------------------------------------------------
// parsePython: every fixture below is a REAL `python3 -m pytest -q --color=no`
// run (pytest 9.1.1, CPython 3.14 on macOS), not an invented approximation --
// same evidentiary bar the JS/Rust fixtures in revert-oracle.test.mjs hold to.
// ---------------------------------------------------------------------------

test('parsePython: "2 passed in 0.00s" is a clean pass', () => {
  const r = parsePython('..                                                                       [100%]\n2 passed in 0.00s\n');
  assert.deepEqual(r, { passed: 2, failed: 0, total: 2, loadEvidence: null });
});

test('parsePython: "1 failed, 1 passed in 0.01s" is a genuine assertion failure', () => {
  const text = [
    '.F                                                                       [100%]',
    '=================================== FAILURES ===================================',
    '________________________________ test_add_fail _________________________________',
    '',
    '    def test_add_fail():',
    '>       assert add(2, 2) == 5',
    'E       assert 4 == 5',
    'E        +  where 4 = add(2, 2)',
    '',
    'test_add.py:7: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED test_add.py::test_add_fail - assert 4 == 5',
    '1 failed, 1 passed in 0.01s',
  ].join('\n');
  const r = parsePython(text);
  assert.deepEqual(r, { passed: 1, failed: 1, total: 2, loadEvidence: null });
});

test('parsePython: "1 error in 0.06s" is a collection failure, not an assertion -- carries loadEvidence', () => {
  const text = [
    '==================================== ERRORS ====================================',
    '_________________________ ERROR collecting test_add.py _________________________',
    "ImportError while importing test module '/w/test_add.py'.",
    'Hint: make sure your test modules/packages have valid Python names.',
    'Traceback:',
    "test_add.py:1: in <module>",
    '    import nonexistentpkg_xyz',
    "E   ModuleNotFoundError: No module named 'nonexistentpkg_xyz'",
    '=========================== short test summary info ============================',
    'ERROR test_add.py',
    '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
    '1 error in 0.06s',
  ].join('\n');
  const r = parsePython(text);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.total, 1);
  assert.match(r.loadEvidence, /ModuleNotFoundError: No module named 'nonexistentpkg_xyz'/);
});

test('parsePython: "1 skipped in 0.00s" collects zero real tests, same as an empty suite', () => {
  const r = parsePython('s                                                                        [100%]\n1 skipped in 0.00s\n');
  assert.deepEqual(r, { passed: 0, failed: 0, total: 0, loadEvidence: null });
});

test('parsePython: "no tests ran in 0.00s" collects zero tests', () => {
  const r = parsePython('no tests ran in 0.00s\n');
  assert.deepEqual(r, { passed: 0, failed: 0, total: 0, loadEvidence: null });
});

test('parsePython: unrecognisable output is null, not a guessed pass', () => {
  const r = parsePython('some unrelated tool output\n');
  assert.deepEqual(r, { passed: null, failed: null, total: null, loadEvidence: null });
});

// ---------------------------------------------------------------------------
// The unavailable-interpreter/toolchain path: this must be honest and
// distinguishable, never a silent pass. `python3` itself missing is caught
// generically via spawnSync's ENOENT (run.spawnError) in
// scripts/lib/revert-oracle.mjs's parseRunnerOutput -- exercised there, not
// here. `pytest` missing FOR a present python3 prints a real, distinct
// message that only PYTEST_MISSING_PATTERN can see; verified against a real
// `/usr/bin/python3 -m pytest` run with no pytest installed (the Command Line
// Tools' python3, distinct from the Homebrew one used by the other fixtures):
//   "/Library/Developer/CommandLineTools/usr/bin/python3: No module named pytest"
// ---------------------------------------------------------------------------

test('#4050: PYTEST_MISSING_PATTERN matches the real "no module named pytest" toolchain message', () => {
  assert.match(
    '/Library/Developer/CommandLineTools/usr/bin/python3: No module named pytest',
    PYTEST_MISSING_PATTERN,
  );
});

test('PYTEST_MISSING_PATTERN does NOT match a quoted ModuleNotFoundError from inside a test\'s own import', () => {
  // That case is the test SUBJECT's dependency missing (e.g. ifcopenshell not
  // installed), not the runner -- it must read as a load failure via
  // parsePython's `errors` branch, never as a runner-missing toolchain gap.
  assert.doesNotMatch("ModuleNotFoundError: No module named 'pytest'", PYTEST_MISSING_PATTERN);
  assert.doesNotMatch("ModuleNotFoundError: No module named 'ifcopenshell'", PYTEST_MISSING_PATTERN);
});
