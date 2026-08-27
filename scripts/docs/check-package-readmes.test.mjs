/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the anti-vacuity floors in check-package-readmes.mjs
 * (#3200, finding 9).
 *
 * The gate derives its root from its own location, so a copy of the one file
 * into a synthetic tree is the whole reproduction.
 *
 * The unreadable-path fixture is ENOTDIR (a file where a directory belongs),
 * not `chmod 000`: chmod does not stop root and CI containers run as root, so
 * a permissions fixture would silently test nothing on the machine that
 * matters. ENOTDIR takes the same branch for every user.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-package-readmes.mjs');

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'check-package-readmes-'));
  mkdirSync(join(root, 'scripts', 'docs'), { recursive: true });
  copyFileSync(GATE, join(root, 'scripts', 'docs', 'check-package-readmes.mjs'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  return root;
}

function addPackage(root, dir, { published = true, readme = true } = {}) {
  mkdirSync(join(root, 'packages', dir), { recursive: true });
  writeFileSync(
    join(root, 'packages', dir, 'package.json'),
    JSON.stringify({ name: `@x/${dir}`, version: '1.0.0', ...(published ? {} : { private: true }) }),
  );
  if (readme) writeFileSync(join(root, 'packages', dir, 'README.md'), `# ${dir}\n`);
}

/** CHECKED_FLOOR published packages, all with READMEs — the healthy shape. */
function fillToFloor(root) {
  for (let i = 0; i < 25; i++) addPackage(root, `p${i}`);
}

function run(root) {
  const res = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'docs', 'check-package-readmes.mjs')],
    { encoding: 'utf-8' },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

test('an empty packages/ is refused, not reported as every package having a README', () => {
  const root = makeTree();
  const { status, out } = run(root);
  // Was: `✅ All 0 published packages have a README.md.` and exit 0.
  assert.equal(status, 1, out);
  assert.match(out, /only 0 published package\(s\) reached the README check/);
  assert.match(out, /expected at least 25/);
  // The remedy must NAME the constant. A message that says only "the SCAN is
  // wrong" is actively misleading to someone who really did retire packages.
  assert.match(out, /lower CHECKED_FLOOR in this file/);
  assert.doesNotMatch(out, /✅/);
  rmSync(root, { recursive: true, force: true });
});

test('a packages/ that cannot be listed names itself instead of throwing a stack trace', () => {
  const root = makeTree();
  rmSync(join(root, 'packages'), { recursive: true, force: true });
  writeFileSync(join(root, 'packages'), 'not a directory');
  const { status, out } = run(root);
  assert.equal(status, 1, out);
  assert.match(out, /cannot list .*packages \(ENOTDIR\)/);
  assert.match(out, /found nowhere to look for them/);
  rmSync(root, { recursive: true, force: true });
});

test('a package that cannot be READ is fatal, not silently dropped from the count', () => {
  const root = makeTree();
  fillToFloor(root);
  // A file where a package directory belongs: statting its package.json is
  // ENOTDIR. `existsSync` answered false here, so the package left the audit
  // and any missing README left with it.
  writeFileSync(join(root, 'packages', 'locked'), 'not a directory');
  const { status, out } = run(root);
  assert.equal(status, 1, out);
  assert.match(out, /cannot read package manifest .*locked[/\\]package\.json \(ENOTDIR\)/);
  assert.doesNotMatch(out, /✅/);
  rmSync(root, { recursive: true, force: true });
});

test('a directory with no package.json stays ordinary and is skipped in silence', () => {
  const root = makeTree();
  fillToFloor(root);
  mkdirSync(join(root, 'packages', 'not-a-package'), { recursive: true });
  const { status, out } = run(root);
  assert.equal(status, 0, out);
  assert.match(out, /All 25 published packages have a README\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('private packages are still excluded, and do not count towards the floor', () => {
  const root = makeTree();
  fillToFloor(root);
  addPackage(root, 'priv', { published: false, readme: false });
  const { status, out } = run(root);
  assert.equal(status, 0, out);
  assert.match(out, /All 25 published packages have a README\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('negative control: the missing-README verdict still fires, and before the floor', () => {
  const root = makeTree();
  fillToFloor(root);
  addPackage(root, 'no-readme', { readme: false });
  const { status, out } = run(root);
  assert.equal(status, 1, out);
  assert.match(out, /Published packages without a README\.md \(1\)/);
  assert.match(out, /@x\/no-readme/);
  // The floor must not have swallowed the gate's actual job: 26 packages clears
  // CHECKED_FLOOR, so the only thing that can fail here is the README check.
  assert.doesNotMatch(out, /expected at least/, 'failed on the floor, not on the README');
  rmSync(root, { recursive: true, force: true });
});

test('positive control: a healthy tree at the floor passes, with its true count', () => {
  const root = makeTree();
  fillToFloor(root);
  const { status, out } = run(root);
  assert.equal(status, 0, out);
  assert.match(out, /✅ All 25 published packages have a README\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('a `.DS_Store` dotfile in packages/ is not a candidate package (PR 3350)', () => {
  const root = makeTree();
  fillToFloor(root);
  // macOS drops this into any directory Finder has opened. Before the skip,
  // statting `.DS_Store/package.json` raised ENOTDIR and existsOrFail refused
  // it, failing the docs gate on a local-only file.
  writeFileSync(join(root, 'packages', '.DS_Store'), '\0\0\0');
  const { status, out } = run(root);
  assert.equal(status, 0, out);
  assert.match(out, /All 25 published packages have a README\.md/);
  assert.doesNotMatch(out, /DS_Store/, 'the dotfile must not appear in the verdict at all');
  rmSync(root, { recursive: true, force: true });
});

test('skipping dotfiles does not soften the refusal: a non-dotfile unreadable candidate still fails (PR 3350)', () => {
  const root = makeTree();
  fillToFloor(root);
  // Both in the same tree, so this pins that exactly one is ignored and the
  // other is refused. Catching ENOTDIR and continuing would have satisfied the
  // test above while destroying the guarantee this gate exists for, and this
  // is the case that catches it.
  writeFileSync(join(root, 'packages', '.DS_Store'), '\0\0\0');
  writeFileSync(join(root, 'packages', 'not-a-dir'), 'this is a file, not a package directory');
  const { status, out } = run(root);
  assert.equal(status, 1, out);
  assert.match(out, /cannot read package manifest/);
  assert.match(out, /not-a-dir/);
  assert.doesNotMatch(out, /DS_Store/, 'the dotfile must not be what tripped it');
  rmSync(root, { recursive: true, force: true });
});
