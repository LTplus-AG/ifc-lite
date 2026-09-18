#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-i18n-literals.mjs and its detector,
 * scripts/lib/i18n-literals-scan.mjs (#4918 "what ends it" gate).
 *
 * Two layers, same reason `check-module-size.test.mjs` pins its harness
 * separately from `lib/module-size-ratchet.test.mjs`'s counting: the
 * DETECTOR (does a hardcoded JSX literal get caught, does an allowlisted
 * `IfcWall` get spared) is unit-tested directly against the fixture text
 * below; the CLI (file-walking, the per-file baseline, the ratchet's
 * rise-fails/fall-reminds asymmetry) is black-box tested with `spawnSync`
 * against a synthetic tree in a temp dir, the same method
 * `check-module-size.test.mjs` uses, so nothing here reads the checker's
 * own source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countLiterals, isAllowlistedLiteral, findLiterals } from './lib/i18n-literals-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-i18n-literals.mjs');

// ── Detector fixture ──────────────────────────────────────────────────

const FIXTURE_TSX = `
export function Example() {
  return (
    <div>
      <span>Reset Colors</span>
      <button aria-label="Reset the color overrides" />
      <span>IfcWall</span>
      <span>PDF</span>
      <span>⌘Z</span>
    </div>
  );
}
`;

test('findLiterals catches the hardcoded JSX text and aria-label', () => {
  const found = findLiterals(FIXTURE_TSX).map((l) => l.text);
  assert.ok(found.includes('Reset Colors'), 'plain JSX text must be found');
  assert.ok(found.includes('Reset the color overrides'), 'aria-label literal must be found');
});

test('isAllowlistedLiteral spares an IFC EXPRESS name, an acronym, and a shortcut glyph', () => {
  assert.equal(isAllowlistedLiteral('IfcWall'), true);
  assert.equal(isAllowlistedLiteral('PDF'), true);
  assert.equal(isAllowlistedLiteral('⌘Z'), true);
});

test('isAllowlistedLiteral does NOT spare hardcoded UI prose', () => {
  assert.equal(isAllowlistedLiteral('Reset Colors'), false);
  assert.equal(isAllowlistedLiteral('Reset the color overrides'), false);
  assert.equal(isAllowlistedLiteral('Esc'), false, 'mixed-case "Esc" is prose, not an acronym');
});

test('countLiterals counts exactly the non-allowlisted literals in the fixture', () => {
  // "Reset Colors" (JSX text) + "Reset the color overrides" (aria-label) = 2.
  // IfcWall, PDF, and ⌘Z are all allowlisted.
  assert.equal(countLiterals(FIXTURE_TSX), 2);
});

test('a file with only allowlisted content counts zero', () => {
  const clean = `
    export function Clean() {
      return <div><span>IfcWall</span><span>PDF</span><span>⌘Z</span></div>;
    }
  `;
  assert.equal(countLiterals(clean), 0);
});

// ── CLI harness ────────────────────────────────────────────────────────

function run(args, cwd) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: 'utf8' });
}

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-literals-test-'));
  const componentsDir = join(dir, 'apps', 'viewer', 'src', 'components');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true }); // default --baseline path's parent
  return { dir, componentsDir };
}

function writeComponent(componentsDir, name, content) {
  writeFileSync(join(componentsDir, name), content);
}

test('check mode fails when no baseline exists yet', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    const res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--update writes a per-file baseline with only non-zero counts', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    writeComponent(componentsDir, 'Clean.tsx', '<div><span>IfcWall</span></div>;');
    const res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    const baseline = JSON.parse(readFileSync(join(dir, 'scripts', 'i18n-literals-baseline.json'), 'utf8'));
    assert.deepEqual(Object.keys(baseline), ['apps/viewer/src/components/Foo.tsx']);
    assert.equal(baseline['apps/viewer/src/components/Foo.tsx'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode passes against a baseline that matches, and fails once a file RISES above it', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    res = run(['--root', dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OK/);

    // Add a second hardcoded literal — the count now exceeds its baseline row.
    writeComponent(componentsDir, 'Foo.tsx', `${FIXTURE_TSX}\n<span>Another Hardcoded Label</span>`);
    res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /increased/);
    assert.match(res.stderr, /Foo\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode does NOT fail when a file improves, but reminds to lower the baseline', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    // Convert the file down to zero hardcoded literals.
    writeComponent(componentsDir, 'Foo.tsx', '<div><span>IfcWall</span></div>;');
    res = run(['--root', dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /note:.*Foo\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--update refuses to raise a file past its baseline without --allow-raise', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    writeComponent(componentsDir, 'Foo.tsx', `${FIXTURE_TSX}\n<span>Another Hardcoded Label</span>`);
    res = run(['--root', dir, '--update'], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to raise/);

    res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed when the scan root does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-literals-test-empty-'));
  try {
    const res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
