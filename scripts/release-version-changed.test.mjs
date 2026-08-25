/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof for `scripts/release-version-changed.mjs` — the gate that
 * decides whether the publish verifiers run at all.
 *
 * Every case is a REAL throwaway git repository, not a stubbed filesystem:
 * the thing under test is a comparison against `HEAD~1`, so a test that
 * stubbed git away would prove nothing about the case that broke — a release
 * commit that bumps workspace packages while the ROOT version stands still.
 * `sync-versions.js` sets the root version to the HIGHEST workspace version
 * and deliberately does not lockstep the rest, so on this repo's real history
 * only a minority of `chore: version packages` commits move the root version.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { versionChanged } from './release-version-changed.mjs';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'release-version-changed.mjs');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Write `{ name, version }` package.json files, keyed by repo-relative path. */
function writePackages(repo, files) {
  for (const [rel, version] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify({ name: rel.replace(/\//g, '-'), version }, null, 2)}\n`);
  }
}

/** A repo whose HEAD~1 carries `before` and whose working tree carries `after`. */
function makeRepo(t, before, after) {
  const repo = mkdtempSync(join(tmpdir(), 'ifclite-version-gate-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  if (before) {
    writePackages(repo, before);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'before']);
  }
  writePackages(repo, after);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'after', '--allow-empty']);
  return repo;
}

test('a root-version bump opens the gate', (t) => {
  const repo = makeRepo(
    t,
    { 'package.json': '1.0.0', 'packages/wasm/package.json': '1.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '1.1.0', 'packages/wasm/package.json': '1.1.0', 'packages/core/package.json': '0.4.1' }
  );
  const result = versionChanged(repo);
  assert.equal(result.changed, true);
});

test('a bump that leaves the ROOT version alone still opens the gate', (t) => {
  // The real shape of ~72% of this repo's release commits: changesets bumps
  // some subset of workspace packages, none of them the one package whose
  // version `sync-versions.js` mirrors into the root — so the root version is
  // byte-identical to HEAD~1 while a genuine publish is happening.
  const repo = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/wasm/package.json': '6.0.0', 'packages/core/package.json': '0.4.1', 'apps/viewer/package.json': '2.0.0' },
    { 'package.json': '6.0.0', 'packages/wasm/package.json': '6.0.0', 'packages/core/package.json': '0.4.2', 'apps/viewer/package.json': '2.0.0' }
  );
  const result = versionChanged(repo);
  assert.equal(result.changed, true, 'a non-root package bump is still a release commit');
  assert.deepEqual(
    result.bumps.map((b) => b.path),
    ['packages/core/package.json']
  );
});

test('an apps/* bump alone opens the gate', (t) => {
  const repo = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1', 'apps/viewer/package.json': '2.0.0' },
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1', 'apps/viewer/package.json': '2.0.1' }
  );
  assert.equal(versionChanged(repo).changed, true);
});

test('a brand-new workspace package opens the gate', (t) => {
  const repo = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1', 'packages/brand-new/package.json': '0.1.0' }
  );
  assert.equal(versionChanged(repo).changed, true);
});

test('an ordinary push with no version change keeps the gate shut', (t) => {
  const repo = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/wasm/package.json': '6.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '6.0.0', 'packages/wasm/package.json': '6.0.0', 'packages/core/package.json': '0.4.1' }
  );
  const result = versionChanged(repo);
  assert.equal(result.changed, false);
  assert.deepEqual(result.bumps, []);
});

test('a deleted workspace package is not a version bump', (t) => {
  // Removing a package changes the workspace but publishes nothing, and the
  // verifiers derive what they expect from the tree AS CHECKED OUT — so a
  // removal must not fire them.
  const repo = mkdtempSync(join(tmpdir(), 'ifclite-version-gate-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  writePackages(repo, { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1', 'packages/gone/package.json': '0.1.0' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'before']);
  rmSync(join(repo, 'packages/gone'), { recursive: true, force: true });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'after', '--allow-empty']);
  assert.equal(versionChanged(repo).changed, false);
});

test('an unreadable parent errs towards verifying', (t) => {
  // Root commit / shallow clone: there is nothing to compare against. The
  // gate must not read "no bump" from "cannot tell" — a false `false` skips
  // verification on a release, a false `true` costs one registry query.
  const repo = makeRepo(t, null, { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1' });
  const result = versionChanged(repo);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'no-parent');
});

test('the CLI prints the verdict on stdout', (t) => {
  const bumped = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.2' }
  );
  const quiet = makeRepo(
    t,
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '6.0.0', 'packages/core/package.json': '0.4.1' }
  );
  const run = (cwd) =>
    execFileSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(run(bumped), 'true');
  assert.equal(run(quiet), 'false');
});

test('an unexpected failure fails OPEN rather than skipping verification', (t) => {
  // Not a git repository at all: the script must still answer `true`, because
  // the alternative is a silent `false` that skips the publish verifiers on a
  // real release — the exact failure mode #3181 is about.
  const notARepo = mkdtempSync(join(tmpdir(), 'ifclite-version-gate-'));
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  writePackages(notARepo, { 'package.json': '6.0.0' });
  const out = execFileSync(process.execPath, [scriptPath], {
    cwd: notARepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(out, 'true');
});
