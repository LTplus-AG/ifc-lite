#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-jsx-a11y.mjs (#5607) and the
 * comparison under it, scripts/lib/count-ratchet.mjs.
 *
 * Black-box only: the CLI (real oxlint, the per-file baseline, the
 * rise-fails / fall-is-reported ratchet) runs with `spawnSync` against a
 * synthetic tree in a temp dir, the same method check-i18n-literals.test.mjs
 * uses, so nothing here reads the checker's own source. The comparison is
 * covered through it (a raised row, a key new to the baseline, a lowered
 * row, a row gone to zero) rather than imported: this file must still LOAD
 * with the gate reverted, so that the revert oracle sees its assertions go
 * red instead of a module that never loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './check-lint-ran.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-jsx-a11y.mjs');

// ── CLI, against a synthetic tree ─────────────────────────────────────

/** A clickable div with no role and no key handler: two jsx-a11y warnings
 *  (click-events-have-key-events + no-static-element-interactions). */
const CLICKABLE_DIV = '<div onClick={() => go()}>x</div>';
const WARNINGS_PER_DIV = 2;

function component(divs) {
  return `export function C({ go }: { go: () => void }) {\n  return (\n    <section>\n${
    Array.from({ length: divs }, () => `      ${CLICKABLE_DIV}\n`).join('')
  }    </section>\n  );\n}\n`;
}

/** A root with every lint target the checker requires, its own config, and
 *  one component with `divs` clickable divs. */
function makeTree(divs) {
  const root = mkdtempSync(join(tmpdir(), 'jsx-a11y-'));
  for (const { dir } of TARGETS) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify({ plugins: ['jsx-a11y'], categories: {}, rules: {} }));
  writeComponent(root, divs);
  // A non-a11y warning the ratchet must NOT count.
  writeFileSync(join(root, 'packages', 'unused.ts'), 'const unused = 1;\n');
  return root;
}

function writeComponent(root, divs, name = 'Widget') {
  mkdirSync(join(root, 'apps', 'ui'), { recursive: true });
  writeFileSync(join(root, 'apps', 'ui', `${name}.tsx`), component(divs));
}

function run(root, ...flags) {
  // No gate at all must fail as an assertion here, never as the loader's own
  // module-not-found text echoed into an assertion message below.
  assert.ok(existsSync(CHECKER), 'scripts/check-jsx-a11y.mjs does not exist, so nothing ratchets jsx-a11y warnings');
  return spawnSync(process.execPath, [CHECKER, '--root', root, ...flags], { encoding: 'utf8' });
}

function baselineOf(root) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'jsx-a11y-baseline.json'), 'utf8'));
}

function withTree(divs, fn) {
  const root = makeTree(divs);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('no baseline fails and names the command that records one', () => {
  withTree(1, (root) => {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no baseline/);
    assert.match(r.stderr, /--update/);
  });
});

test('--update refuses to raise without --allow-raise, and records per-file counts with it', () => {
  withTree(1, (root) => {
    const refused = run(root, '--update');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to raise/);

    const seeded = run(root, '--update', '--allow-raise');
    assert.equal(seeded.status, 0, seeded.stderr);
    // Only jsx-a11y diagnostics are counted: packages/unused.ts carries a
    // no-unused-vars warning and gets no row.
    assert.deepEqual(baselineOf(root), { 'apps/ui/Widget.tsx': WARNINGS_PER_DIV });
    assert.equal(run(root).status, 0);
  });
});

test('an INCREASE in a file fails and names the file', () => {
  withTree(1, (root) => {
    assert.equal(run(root, '--update', '--allow-raise').status, 0);
    writeComponent(root, 2);
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`apps/ui/Widget\\.tsx: ${2 * WARNINGS_PER_DIV} \\(baseline ${WARNINGS_PER_DIV}, \\+${WARNINGS_PER_DIV}\\)`));
  });
});

test('a file NEW to the baseline is allowed zero warnings', () => {
  withTree(1, (root) => {
    assert.equal(run(root, '--update', '--allow-raise').status, 0);
    writeComponent(root, 1, 'Fresh');
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`apps/ui/Fresh\\.tsx: ${WARNINGS_PER_DIV} \\(baseline 0, \\+${WARNINGS_PER_DIV}\\)`));
  });
});

test('a DECREASE passes, is reported, and --update lowers the row without --allow-raise', () => {
  withTree(2, (root) => {
    assert.equal(run(root, '--update', '--allow-raise').status, 0);
    writeComponent(root, 1);
    // Unrecorded, the decrease passes (a stale row must not turn main red
    // when a concurrent PR fixes warnings) and says how to tighten.
    const stale = run(root);
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, new RegExp(`apps/ui/Widget\\.tsx: ${WARNINGS_PER_DIV} warning\\(s\\), baseline ${2 * WARNINGS_PER_DIV}; lower the baseline`));

    const lowered = run(root, '--update');
    assert.equal(lowered.status, 0, lowered.stderr);
    assert.deepEqual(baselineOf(root), { 'apps/ui/Widget.tsx': WARNINGS_PER_DIV });
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

test('a file fixed to zero drops its row', () => {
  withTree(1, (root) => {
    assert.equal(run(root, '--update', '--allow-raise').status, 0);
    writeComponent(root, 0);
    const stale = run(root);
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /apps\/ui\/Widget\.tsx: 0 warning\(s\), baseline \d+; lower the baseline/);
    assert.equal(run(root, '--update').status, 0);
    assert.deepEqual(baselineOf(root), {});
    assert.equal(run(root).status, 0);
  });
});

test('a missing lint target fails closed rather than going unmeasured', () => {
  withTree(1, (root) => {
    rmSync(join(root, 'examples'), { recursive: true, force: true });
    const r = run(root, '--update', '--allow-raise');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lint target\(s\) missing/);
  });
});

test('--allow-raise without --update is rejected', () => {
  withTree(1, (root) => {
    const r = run(root, '--allow-raise');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /only means something with --update/);
  });
});
