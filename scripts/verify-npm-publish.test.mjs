/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the anti-vacuity floors in verify-npm-publish.js
 * (#3200, finding 7).
 *
 * The gate derives its workspace root from its own location, so a copy of the
 * one file into a synthetic tree IS the whole reproduction — no fixtures, no
 * network. `npm` itself is stubbed on PATH for the positive controls; nothing
 * here reaches a registry.
 *
 * Every case asserts the EXIT CODE and the text, because the thing being
 * guarded is precisely a run that says nothing went wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'verify-npm-publish.js');

/** A synthetic workspace holding nothing but a copy of the gate. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'verify-npm-publish-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(GATE, join(root, 'scripts', 'verify-npm-publish.js'));
  return root;
}

function addPackage(root, parent, dir, pkg) {
  mkdirSync(join(root, parent, dir), { recursive: true });
  writeFileSync(join(root, parent, dir, 'package.json'), JSON.stringify(pkg));
}

/**
 * A stub `npm` answering `npm view <name>@<version> version` with the version
 * it was asked for, so a package reads as published. `missing` names the one
 * spec it should 404 on, for the negative control.
 */
function stubNpm(root, { missing = null } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, 'npm');
  const lines = ['#!/bin/sh', 'spec="$2"'];
  if (missing) {
    lines.push(`if [ "$spec" = "${missing}" ]; then echo "npm error code E404" >&2; exit 1; fi`);
  }
  // `sed` rather than a `${spec##*@}` expansion: the literal `${` in a
  // JavaScript single-quoted string trips eslint(no-template-curly-in-string).
  lines.push('echo "$spec" | sed "s/.*@//"', '');
  writeFileSync(npm, lines.join('\n'));
  chmodSync(npm, 0o755);
  return bin;
}

function run(root, { bin = null } = {}) {
  const env = { ...process.env };
  if (bin) env.PATH = `${bin}:${env.PATH}`;
  const res = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'verify-npm-publish.js'), '--retries', '1'],
    { encoding: 'utf-8', env },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** 25 publishable packages — PUBLISHABLE_FLOOR exactly, the healthy shape. */
function fillToFloor(root) {
  for (let i = 0; i < 25; i++) {
    addPackage(root, 'packages', `p${i}`, { name: `@x/p${i}`, version: '1.0.0' });
  }
}

test('a workspace with no manifests at all is refused, not reported verified', () => {
  const root = makeTree();
  mkdirSync(join(root, 'packages'));
  mkdirSync(join(root, 'apps'));
  const { status, out } = run(root);
  assert.equal(status, 2, out);
  assert.match(out, /nothing was verified/);
  rmSync(root, { recursive: true, force: true });
});

test('discovery that finds only private packages is refused, naming the floor it expected', () => {
  const root = makeTree();
  addPackage(root, 'packages', 'priv', { name: '@x/priv', version: '1.0.0', private: true });
  const { status, out } = run(root);
  assert.equal(status, 2, out);
  // Was: `No publishable packages found.` and exit 0 — a release reported
  // verified on zero registry queries.
  assert.match(out, /only 0 publishable package\(s\) found among 1 manifest\(s\)/);
  assert.match(out, /expected at least 25/);
  assert.doesNotMatch(
    out,
    /No publishable packages found/,
    'the pre-#3200 success line must be gone, not merely accompanied',
  );
  // The remedy must NAME the constant. A message that says only "discovery is
  // wrong" is actively misleading to someone who really did retire packages.
  assert.match(out, /lower PUBLISHABLE_FLOOR in this file/);
  rmSync(root, { recursive: true, force: true });
});

test('a workspace parent that cannot be LISTED is fatal, not a warning', () => {
  const root = makeTree();
  // ENOTDIR rather than a chmod, because it takes the same branch for EVERY
  // user including root, so this case cannot be reduced to a skip on any
  // machine. (An earlier version of this comment claimed the CI lane runs as
  // root and that a chmod fixture would therefore test nothing there. Checked:
  // .github/workflows/test.yml declares no `container:` and its jobs run on
  // ubuntu-latest / depot-ubuntu-24.04-4 as the non-root `runner` user, so a
  // chmod fixture does bite in CI — see the EACCES case below, which needs it.)
  writeFileSync(join(root, 'packages'), 'not a directory');
  addPackage(root, 'apps', 'pub', { name: '@x/pub', version: '2.0.0' });
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 2, out);
  assert.match(out, /could not list .*packages \(ENOTDIR\)/);
  assert.match(out, /an unreadable workspace parent is not an empty one/);
  assert.doesNotMatch(out, /All packages are published/);
  rmSync(root, { recursive: true, force: true });
});

test('a stray FILE under packages/ is ordinary, not fatal', () => {
  // This asserted the opposite and was wrong. A plain file under packages/
  // makes packages/<file>/package.json ENOTDIR, and the gate deliberately
  // treats that as "not a package" rather than as an unreadable path.
  //
  // Checked against the real tree rather than argued: this repo carries
  // `packages/.DS_Store` and `apps/.DS_Store` right now. Both are gitignored,
  // so the release lane never sees them -- the run this would break is a local
  // one on macOS, which is where anyone debugging a release runs it.
  //
  // TWO strays on purpose, one dotted and one not. With only the dotfile, a
  // future `if (entry.startsWith('.')) continue;` upstream of the stat would
  // make this test pass while child ENOTDIR was fatal again, and the property
  // would have no coverage left -- measured, that mutation turns all 8 green.
  // `README.txt` is the case that has no dot to hide behind: an editor backup
  // or a build turd under packages/ must stay ordinary too.
  //
  // The genuinely-unclassifiable case is the test below. ENOTDIR one level UP
  // (packages/ itself being a file) stays fatal and is covered separately,
  // because that one really does shrink the verified set by a whole tree.
  const root = makeTree();
  fillToFloor(root);
  writeFileSync(join(root, 'packages', '.DS_Store'), 'not a directory');
  writeFileSync(join(root, 'packages', 'README.txt'), 'not a directory either');
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 0, out);
  assert.match(out, /Verifying 25 package\(s\)/);
  assert.doesNotMatch(out, /could not stat/);
  rmSync(root, { recursive: true, force: true });
});

test('a non-directory under packages/ is NAMED, so a clobbered package leaves a trace', () => {
  // ENOTDIR proves only that the entry is not a directory, so a stray file and
  // a package directory replaced by a file are indistinguishable here. Treating
  // it as ordinary is right; treating it as SILENT is not. The only backstop is
  // PUBLISHABLE_FLOOR, and against 42 real publishable packages with a floor of
  // 25, up to 17 could vanish this way and the gate would still report green.
  //
  // So the run must NAME them. `.DS_Store` is the ordinary case and `p26` is a
  // package directory clobbered into a file; both appear, because the gate
  // genuinely cannot tell them apart and should not pretend to.
  const root = makeTree();
  fillToFloor(root);
  writeFileSync(join(root, 'packages', '.DS_Store'), 'stray');
  writeFileSync(join(root, 'packages', 'p26'), 'a package directory, clobbered');
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 0, out);
  assert.match(out, /are not directories and hold no package/);
  assert.match(out, /p26/, `a clobbered package directory must be named:\n${out}`);
  assert.match(out, /\.DS_Store/);
  // Still verifies the real ones -- the note is not a substitute for the work.
  assert.match(out, /Verifying 25 package\(s\)/);
  rmSync(root, { recursive: true, force: true });
});

test('a manifest path that cannot be STATed is fatal, not skipped', (t) => {
  // EACCES, not ENOTDIR: a path that exists in some form the gate could not
  // classify. Skipping it would drop a package the release was supposed to
  // publish, and every remaining package would still report a tick.
  if (process.getuid?.() === 0) {
    // Say so out loud. A permission fixture is meaningless as root, and a
    // guard test that quietly passes because its fixture did not bite is the
    // exact shape #3200 is about.
    t.skip('running as root: chmod 000 does not deny access, fixture cannot bite');
    return;
  }
  const root = makeTree();
  const denied = join(root, 'packages', 'broken');
  mkdirSync(denied, { recursive: true });
  chmodSync(denied, 0o000);
  try {
    const { status, out } = run(root);
    assert.equal(status, 2, out);
    assert.match(out, /could not stat .*broken[/\\]package\.json \(EACCES\)/);
  } finally {
    chmodSync(denied, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory with no package.json is still ordinary and skipped in silence', () => {
  const root = makeTree();
  fillToFloor(root);
  mkdirSync(join(root, 'packages', 'not-a-package'), { recursive: true });
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 0, out);
  assert.match(out, /Verifying 25 package\(s\)/);
  assert.doesNotMatch(out, /could not stat/);
  rmSync(root, { recursive: true, force: true });
});

test('positive control: a healthy workspace at the floor still passes, with its count', () => {
  const root = makeTree();
  fillToFloor(root);
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 0, out);
  assert.match(out, /Verifying 25 package\(s\)/);
  assert.match(out, /All packages are published/);
  rmSync(root, { recursive: true, force: true });
});

test('negative control: one package missing from the registry still exits 1', () => {
  const root = makeTree();
  fillToFloor(root);
  const { status, out } = run(root, { bin: stubNpm(root, { missing: '@x/p7@1.0.0' }) });
  assert.equal(status, 1, out);
  assert.match(out, /1 package\(s\) missing from npm after publish/);
  assert.match(out, /@x\/p7@1\.0\.0/);
  rmSync(root, { recursive: true, force: true });
});
