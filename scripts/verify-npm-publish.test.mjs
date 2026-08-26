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
  rmSync(root, { recursive: true, force: true });
});

test('a workspace parent that cannot be LISTED is fatal, not a warning', () => {
  const root = makeTree();
  // ENOTDIR rather than a chmod: `chmod 000` does not stop root and CI
  // containers run as root, so a permissions fixture would silently test
  // nothing on the machine that matters. A file where a directory belongs
  // takes the same branch for every user.
  writeFileSync(join(root, 'packages'), 'not a directory');
  addPackage(root, 'apps', 'pub', { name: '@x/pub', version: '2.0.0' });
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 2, out);
  assert.match(out, /could not list .*packages \(ENOTDIR\)/);
  assert.doesNotMatch(out, /All packages are published/);
  rmSync(root, { recursive: true, force: true });
});

test('a stray FILE under packages/ is ordinary, not fatal', () => {
  // This asserted the opposite and was wrong. A plain file under packages/
  // makes packages/<file>/package.json ENOTDIR, and the gate deliberately
  // treats that as "not a package" rather than as an unreadable path.
  //
  // Checked against the real tree rather than argued: this repo carries
  // `packages/.DS_Store` and `apps/.DS_Store` right now. Had ENOTDIR been
  // fatal here, the release gate would refuse on every macOS checkout -- a
  // guard that fires on a Finder artefact is worse than the hole it closes.
  //
  // The genuinely-unclassifiable case is the test below. ENOTDIR one level UP
  // (packages/ itself being a file) stays fatal and is covered separately,
  // because that one really does shrink the verified set by a whole tree.
  const root = makeTree();
  fillToFloor(root);
  writeFileSync(join(root, 'packages', '.DS_Store'), 'not a directory');
  const { status, out } = run(root, { bin: stubNpm(root) });
  assert.equal(status, 0, out);
  assert.match(out, /Verifying 25 package\(s\)/);
  assert.doesNotMatch(out, /could not stat/);
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
