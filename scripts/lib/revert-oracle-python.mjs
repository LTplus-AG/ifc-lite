/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Python support for the revert oracle (`scripts/check-test-revert-oracle.mjs`).
 *
 * Split out of `revert-oracle.mjs` to keep that file at its recorded
 * module-size budget (#4050): classifying a `test_*.py` file as a test needed
 * only a regex change there, but actually running one needs a project-owner
 * lookup (mirroring `cargoTestOwner` in `revert-oracle-cargo.mjs`), a runner,
 * and an output parser — enough surface to earn its own file.
 *
 * WHY A PROJECT-OWNER WALK, LIKE CARGO. A Python test file carries no manifest
 * of its own the way a JS test's nearest `package.json` does. `pythonTestOwner`
 * walks up from the test file looking for the nearest recognised project
 * marker — this repo's real instance is
 * `tools/ifcopenshell_reference/requirements.lock` — and runs pytest from
 * there. A test file with no such marker above it is left `unassigned` by the
 * caller rather than guessed at, the same refusal `cargoTestOwner`'s caller
 * applies to a `.rs` file with no owning crate.
 *
 * WHY `python3 -m pytest`, NOT A BARE `pytest` ON PATH. `-m` fails
 * predictably and legibly when pytest is not installed for that interpreter
 * (see `parsePython` and `PYTEST_MISSING_PATTERN` below), and runs under
 * whichever interpreter `python3` resolves to. This mirrors `cargoRunner`
 * always shelling out to a bare `cargo` and letting `spawnSync`'s ENOENT speak
 * for a missing toolchain — an absent `python3` itself is caught the same
 * generic way, via `run.spawnError` in `parseRunnerOutput`.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Files that anchor a Python project root, checked nearest-first. */
const PROJECT_MARKERS = ['requirements.lock', 'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'];

/** Mirrors `cargoTestOwner`: walk up from the test file to the nearest project marker. */
export function pythonTestOwner(file, root) {
  let dir = dirname(file);
  while (!isAbsolute(relative(root, dir)) && relative(root, dir).split(sep)[0] !== '..') {
    if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return { dir };
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}

/**
 * pytest invocation for a project directory's `test_*.py` / `*_test.py` files.
 * `-B` stops CPython writing `__pycache__/*.pyc` into the working tree: the
 * oracle's restoration step (`check-test-revert-oracle.mjs`) proves the tree
 * is byte-identical afterwards via `git status --porcelain`, and an untracked
 * `.pyc` left behind by an ordinary test run would fail that unrelated to any
 * revert. `.pytest_cache/` needs no such flag — pytest writes its own
 * `.gitignore` inside it, so git already ignores it.
 */
export function pythonRunner(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return { family: 'python', bin: 'python3', args: ['-B', '-m', 'pytest', '-q', '--color=no', ...files] };
}

/**
 * `python3 -m X` on a missing module prints an UNQUOTED `No module named X` to
 * stderr and exits 1 — structurally distinct from `ModuleNotFoundError: No
 * module named 'x'` (quoted, raised from inside a test's own `import`), which
 * means the test SUBJECT's dependency is missing, not the runner itself. Only
 * the unquoted form means "this toolchain is not provisioned"; it is folded
 * into `revert-oracle.mjs`'s `RUNNER_MISSING_PATTERNS` so a missing pytest
 * reports exactly the way an absent `cargo` or `vitest` binary already does —
 * never as a silent pass. Verified against real `python3 -m pytest` output
 * (pytest absent, CPython 3.14): `No module named pytest`. Exported, rather
 * than duplicated as a second regex, so the two files cannot drift apart.
 */
export const PYTEST_MISSING_PATTERN = /No module named pytest\b/;

/**
 * Parse `python3 -m pytest -q --color=no`'s final summary line. Every branch
 * below is a real captured pytest 9.1.1 / CPython 3.14 run (quoted verbatim in
 * `revert-oracle-python.test.mjs`):
 *   "2 passed in 0.00s"
 *   "1 failed, 1 passed in 0.01s"
 *   "1 error in 0.06s"          — "ERROR collecting <file>", body never ran
 *   "1 skipped in 0.00s"
 *   "no tests ran in 0.00s"
 */
export function parsePython(text) {
  const passed = num(/(\d+) passed/.exec(text));
  const failed = num(/(\d+) failed/.exec(text));
  const errors = num(/(\d+) error/.exec(text));
  const skipped = num(/(\d+) skipped/.exec(text));

  if (passed === null && failed === null && errors === null) {
    // Every collected item skipped (or truly nothing collected): no assertion
    // ran, so this must read as zero tests, not as an unparseable run.
    if (skipped !== null || /no tests ran/.test(text)) {
      return { passed: 0, failed: 0, total: 0, loadEvidence: null };
    }
    return { passed: null, failed: null, total: null, loadEvidence: null };
  }

  // pytest's "error" outcome is a fixture/collection failure: the test body
  // never ran at all — the same trap `node --test`'s whole-file "not ok" line
  // exists to catch, just under a different runner's vocabulary.
  const loadEvidence = errors
    ? `pytest reported ${errors} error(s) during collection/setup — no assertion ran for ${
        errors === 1 ? 'it' : 'them'
      } (${/ModuleNotFoundError: .*/.exec(text)?.[0] ?? /ImportError[^\n]*/.exec(text)?.[0] ?? 'see the ERRORS section'})`
    : null;

  return { passed: passed ?? 0, failed: failed ?? 0, total: (passed ?? 0) + (failed ?? 0) + (errors ?? 0), loadEvidence };
}

function num(m) {
  return m ? Number(m[1]) : null;
}
