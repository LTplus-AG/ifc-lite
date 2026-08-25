#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-swallowed-push.mjs.
 *
 * The gate reports "no swallowed pushes". That sentence is equally true of a
 * clean tree and of a scan that examined nothing, so every way it could go
 * false-green is an executable case here: the workflow directory missing, the
 * directory present but empty, and each spelling of a discarded exit status.
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs: write a
 * mutated tree to a temp dir, run the UNMODIFIED checker against it via
 * `--root`, and assert exit code plus message.
 *
 * Run: node --test scripts/check-swallowed-push.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSwallowedPushes, SWALLOWED_PUSH, MARKER } from './check-swallowed-push.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(SCRIPTS, 'check-swallowed-push.mjs');

/** Writes `files` (relative path -> content) into a temp tree and runs the gate. */
function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'swallowed-push-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = `name: x
jobs:
  release:
    steps:
      - run: |
          git tag "v1" || true
          git push origin "v1"
`;

test('a clean workflow passes, and says how much it looked at', () => {
  const { status, out } = runOn({ '.github/workflows/release.yml': CLEAN });
  assert.equal(status, 0, out);
  assert.match(out, /check-swallowed-push: OK \(1 workflow files/);
});

test('`|| true` on a push is caught', () => {
  const { status, out } = runOn({
    '.github/workflows/release.yml': CLEAN.replace('git push origin "v1"', 'git push origin "v1" || true'),
  });
  assert.equal(status, 1, out);
  assert.match(out, /release\.yml:\d+.*git push origin "v1" \|\| true/);
});

test('`|| :` is caught too — a shell no-op reads as decorative', () => {
  const { status, out } = runOn({
    '.github/workflows/release.yml': CLEAN.replace('git push origin "v1"', 'git push origin "v1" || :'),
  });
  assert.equal(status, 1, out);
});

test('`|| true` on `git tag` is NOT caught — idempotency there is the point', () => {
  // The whole value of this gate is that it separates the two. A rule that
  // flagged both would be suppressed wholesale on its first run.
  const { status } = runOn({ '.github/workflows/release.yml': CLEAN });
  assert.equal(status, 0);
  assert.ok(SWALLOWED_PUSH.test('git push origin "v1" || true'));
  assert.ok(!SWALLOWED_PUSH.test('git tag "v1" || true'));
});

test('a no-op followed by a command-list delimiter is still swallowed', () => {
  // End-of-line was not the only spelling. Chaining after the no-op discards the
  // push status just as thoroughly, and an `(?:$|#)` anchor walks past it.
  // Reported by CodeRabbit on #3208; each of these was verified to flip the
  // regex from false to true.
  const forms = {
    'semicolon': 'git push origin "v1" || true; echo continuing',
    'background': 'git push origin "v1" || true & ',
    'subshell close': '(git push origin "v1" || true)',
    'pipe': 'git push origin "v1" || true | tee log',
  };
  for (const [label, line] of Object.entries(forms)) {
    const { status, out } = runOn({
      '.github/workflows/release.yml': CLEAN.replace('          git push origin "v1"', `          ${line}`),
    });
    assert.equal(status, 1, `${label} was not caught:\n${out}`);
  }
});

test('a marked site is excused AND named, not hidden', () => {
  const marked = CLEAN.replace(
    '          git push origin "v1"',
    `          # ${MARKER}: mirror remote is best-effort\n          git push origin "v1" || true`,
  );
  const { status, out } = runOn({ '.github/workflows/release.yml': marked });
  assert.equal(status, 0, out);
  assert.match(out, /1 marked/);
  assert.match(out, /marked: .*release\.yml/);
});

test('a MISSING workflow directory fails instead of reporting clean', () => {
  // The failure this gate exists to prevent, one level up: a scan that examined
  // nothing must not be indistinguishable from a scan that found nothing.
  const { status, out } = runOn({ 'README.md': 'no workflows here\n' });
  assert.equal(status, 1, out);
  assert.match(out, /scan root has moved|examined nothing/);
});

test('an EMPTY workflow directory fails instead of reporting clean', () => {
  const { status, out } = runOn({ '.github/workflows/.keep': '' });
  assert.equal(status, 1, out);
  assert.match(out, /No workflow files found/);
});

test('the detector reports the right line number', () => {
  // An offender named at the wrong line sends the reader to innocent code.
  const src = ['a', 'b', 'git push origin "x" || true', 'c'].join('\n');
  const { hits } = findSwallowedPushes(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});
