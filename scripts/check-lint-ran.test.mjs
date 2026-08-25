#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for check-lint-ran.mjs losing its output on a pipe.
 *
 * The defect: the gate buffered oxlint's whole output, `process.stdout.write`
 * it, and then `process.exit(status)`. On a PIPE — which is every CI log —
 * Node's stdout is asynchronous, so the exit tore the process down with most
 * of that write still queued. A run producing 120k lines reached the log as
 * ~1k lines, cut off mid-diagnostic, with no summary line and no error line:
 * nothing in the log said the lint had failed, or why. A real CI lint failure
 * (one `eslint(no-control-regex)` error among 226 warnings) was read off such
 * a log as "pre-existing warnings elsewhere, not ours". It was ours.
 *
 * The same run against a TTY or a regular file kept everything, which is why
 * hand-testing never showed it — so the test drives the script through a pipe
 * specifically, and asserts on the BYTES that arrive, not on the exit code
 * (the exit code was always right; the log was the casualty).
 *
 * Run: node --test scripts/check-lint-ran.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-lint-ran.mjs');
const ROOT = join(HERE, '..');

/** One diagnostic line per source finding, repeated until the output is far
 *  past any pipe buffer (~64KiB on Linux and macOS). 40k lines per target is
 *  ~3MiB, the order of magnitude a failing oxlint run over this repo produces. */
const LINES_PER_TARGET = 40_000;

/** How many directories the gate lints, read from the gate itself rather than
 *  hard-coded: adding a target (as #3200 added `examples`) must not require
 *  editing arithmetic in this file, and a test that silently expected the old
 *  count would assert on a run that had stopped covering a directory. */
const TARGET_COUNT = (readFileSync(GATE, 'utf8').match(/^\s*\{ dir: '/gm) ?? []).length;
const TAIL_MARKER = 'LAST-DIAGNOSTIC-LINE';

/**
 * A stand-in for `pnpm exec oxlint …` that prints a realistically large body,
 * then oxlint's summary line, then exits non-zero the way a lint error does.
 *
 * It writes with `fs.writeSync` rather than `process.stdout.write` on purpose:
 * a shim written the natural way reproduces the very bug under test one level
 * down — its own output is truncated before the gate ever sees it — and the
 * test then passes or fails for the wrong reason.
 */
function makeFakeOxlint(status) {
  const dir = mkdtempSync(join(tmpdir(), 'check-lint-ran-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'pnpm');
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const target = process.argv[process.argv.length - 1];
let out = '';
for (let i = 0; i < ${LINES_PER_TARGET}; i++) {
  out += '  x eslint(no-control-regex): Unexpected control character ' + target + ' ' + i + '\\n';
}
out += '${TAIL_MARKER} ' + target + '\\n';
out += 'Finished in 120ms on 2000 files with 300 rules using 8 threads.\\n';
fs.writeSync(1, out);
process.exitCode = ${status};
`,
    'utf8',
  );
  chmodSync(shim, 0o755);
  return { dir, bin };
}

/** Run the gate with its stdout on a PIPE (spawnSync captures through one). */
function runGate(binDir) {
  return spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

test('a failing lint keeps its whole output when stdout is a pipe', () => {
  const { dir, bin } = makeFakeOxlint(1);
  try {
    const run = runGate(bin);
    const stdout = run.stdout ?? '';

    // The gate must still fail — the fix must not swallow the status.
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);

    // One summary per target. This is what vanished: the truncated log ended
    // roughly 1% in, so a reader saw diagnostics and no verdict.
    const summaries = stdout.match(/Finished in [^\n]*? on [\d,]+ files with \d+ rules/g) ?? [];
    assert.equal(summaries.length, TARGET_COUNT, `expected ${TARGET_COUNT} oxlint summaries, got ${summaries.length}`);

    // And the last line before each summary, so this cannot pass on a log that
    // dropped the middle and happened to keep the tail.
    const markers = stdout.match(new RegExp(TAIL_MARKER, 'g')) ?? [];
    assert.equal(markers.length, TARGET_COUNT, `expected ${TARGET_COUNT} tail markers, got ${markers.length}`);

    // Byte-exact: every diagnostic line of every target arrived. Asserting the
    // count rather than "more than a pipe buffer" keeps the test honest if the
    // output grows or the buffer size differs between platforms.
    const diagnostics = stdout.match(/eslint\(no-control-regex\)/g) ?? [];
    assert.equal(diagnostics.length, LINES_PER_TARGET * TARGET_COUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean lint still reports its own summary line through a pipe', () => {
  const { dir, bin } = makeFakeOxlint(0);
  try {
    const run = runGate(bin);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stderr}`);
    // 2,000 files per target from the shim, one line per target.
    const total = (2_000 * TARGET_COUNT).toLocaleString('en-US');
    assert.match(
      run.stdout,
      new RegExp(`lint: ${total} files across ${TARGET_COUNT} targets, 300 rules, no errors\\.`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #3200: a workspace glob outside the target list must be loud ---
//
// The floors catch a target that shrank. They could not catch `examples/*`,
// which was declared in pnpm-workspace.yaml and simply never passed to oxlint:
// six error-tier `eslint(no-inner-declarations)` violations sat in shipped
// sample code while `node scripts/check-lint-ran.mjs` exited 0. Measured on
// upstream/main before the fix:
//
//   $ npx oxlint examples | grep -c ": error "
//   6
//   $ node scripts/check-lint-ran.mjs ; echo $?
//   0
//
// The cross-check runs BEFORE any oxlint spawn, so these cases need no shim:
// a copy of the gate beside a synthetic pnpm-workspace.yaml is the whole
// reproduction, exactly as the gate derives its ROOT from its own location.

/** A throwaway repo root holding `scripts/check-lint-ran.mjs` and the given
 *  `pnpm-workspace.yaml` body (omit it to leave the file out entirely). */
function fakeRoot(workspaceYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'check-lint-ran-ws-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'check-lint-ran.mjs'), readFileSync(GATE, 'utf8'), 'utf8');
  if (workspaceYaml !== null) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf8');
  return dir;
}

function runIn(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-lint-ran.mjs')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

test('a workspace glob with no lint target fails instead of going quietly unlinted', () => {
  const root = fakeRoot("packages:\n  - 'packages/*'\n  - 'apps/*'\n  - 'plugins/*'\n");
  try {
    const run = runIn(root);
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${out}`);
    assert.match(out, /plugins\/ is declared in pnpm-workspace\.yaml but is not a lint target/);
    assert.doesNotMatch(out, /no errors\./, 'must not print a success line at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable pnpm-workspace.yaml is loud, not treated as nothing to cross-check', () => {
  const root = fakeRoot(null);
  try {
    const run = runIn(root);
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${out}`);
    assert.match(out, /Refusing a vacuous pass/);
    assert.match(out, /could not read .*pnpm-workspace\.yaml: ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty package glob list is refused rather than agreeing with any target list', () => {
  // `packages:` present, no items under it — the shape that would make the
  // cross-check trivially satisfied by an empty TARGETS.
  const root = fakeRoot('packages:\n\nonlyBuiltDependencies:\n  - esbuild\n');
  try {
    const run = runIn(root);
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${out}`);
    assert.match(out, /declares no package globs/);
    assert.match(out, /Refusing a vacuous pass/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exclusion glob is not treated as a workspace member needing its own target', () => {
  // pnpm supports `!`-prefixed exclusion globs (documented workspace
  // feature) that narrow an inclusion glob rather than declare a new place
  // to lint. Before the fix, `!packages/legacy-thing` failed the cross-check
  // with a message naming `!packages/` - a directory that does not exist -
  // which is exactly the "gate blocks a legitimate change" shape this line
  // of work exists to prevent.
  const root = fakeRoot(
    "packages:\n  - 'packages/*'\n  - 'apps/*'\n  - 'scripts'\n  - 'examples/*'\n  - '!packages/legacy-thing'\n",
  );
  try {
    const run = runIn(root);
    const out = `${run.stdout}${run.stderr}`;
    assert.doesNotMatch(out, /is not a lint target/, `exclusion glob must not be flagged: ${out}`);
    assert.doesNotMatch(out, /declares no package globs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real pnpm-workspace.yaml parses to the globs it actually declares', () => {
  // Guards the hand-rolled YAML reader against the block below `packages:`
  // bleeding in: `onlyBuiltDependencies` items are list entries too, and a
  // reader that swallowed them would demand lint targets named `@clerk` etc.
  const root = fakeRoot(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
  try {
    // Every declared glob is covered by a target, so the cross-check passes and
    // the gate goes on to spawn oxlint — which is absent from this tree, so it
    // fails LATER, with a different message. That distinction is the assertion.
    const run = runIn(root);
    const out = `${run.stdout}${run.stderr}`;
    assert.doesNotMatch(out, /is not a lint target/);
    assert.doesNotMatch(out, /declares no package globs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
