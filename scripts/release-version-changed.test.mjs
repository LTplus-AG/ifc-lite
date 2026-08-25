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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

test('a ROOT-version bump alone opens the gate', (t) => {
  // ONLY the root moves. The earlier spelling of this test bumped the root
  // AND `packages/wasm` together, so deleting the root entry from
  // `currentVersions` killed nothing — the workspace bump carried the
  // assertion and the root path was never actually covered.
  const repo = makeRepo(
    t,
    { 'package.json': '1.0.0', 'packages/wasm/package.json': '1.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '1.1.0', 'packages/wasm/package.json': '1.0.0', 'packages/core/package.json': '0.4.1' }
  );
  const result = versionChanged(repo);
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.bumps.map((b) => b.path),
    ['package.json'],
    'the root manifest must be in the walk on its own'
  );
});

test('a root bump alongside the workspace package it mirrors opens the gate', (t) => {
  // The shape `sync-versions.js` actually produces: the root tracks the
  // highest workspace version, so the two move together.
  const repo = makeRepo(
    t,
    { 'package.json': '1.0.0', 'packages/wasm/package.json': '1.0.0', 'packages/core/package.json': '0.4.1' },
    { 'package.json': '1.1.0', 'packages/wasm/package.json': '1.1.0', 'packages/core/package.json': '0.4.1' }
  );
  const result = versionChanged(repo);
  assert.equal(result.changed, true);
  assert.deepEqual(result.bumps.map((b) => b.path).sort(), ['package.json', 'packages/wasm/package.json']);
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

test("a missing root package.json reaches main()'s catch and fails OPEN", (t) => {
  // Reaches the `catch` in `main()` for real, which the case above does NOT:
  // a non-repo returns cleanly through the `no-parent` branch and never
  // throws, so mutating that catch to print `false` left the whole suite
  // green. Here git works and the parent resolves, but `currentVersions`
  // throws ENOENT reading the root manifest — the only path that exercises
  // the fail-open catch the entire gate design rests on.
  const repo = mkdtempSync(join(tmpdir(), 'ifclite-version-gate-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  writePackages(repo, { 'packages/core/package.json': '0.4.1' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'before']);
  git(repo, ['commit', '-qm', 'after', '--allow-empty']);
  // Pin the premise: git works and HEAD~1 resolves, so this is NOT the
  // `no-parent` branch, and the packages that DO exist are unchanged — so
  // without the throw the honest answer would be `false`.
  assert.equal(git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}']).trim().length, 40);
  assert.throws(() => versionChanged(repo), /ENOENT/, 'the premise is a throw out of currentVersions');
  const out = execFileSync(process.execPath, [scriptPath], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(out, 'true', "main()'s catch must fail OPEN");
});

for (const rel of ['package.json', 'packages/core/package.json']) {
  test(`an unparseable ${rel} fails OPEN`, (t) => {
    // A manifest that exists but does not parse is "cannot tell", not "no
    // bump". Skipping it from the walk answers `false` on a tree that may
    // well be a release commit — measured before the fix: an unparseable
    // packages/core/package.json at HEAD, 1.0.0 at the parent, gave
    // `{"changed":false}`.
    const repo = makeRepo(
      t,
      { 'package.json': '6.0.0', 'packages/core/package.json': '1.0.0' },
      { 'package.json': '6.0.0', 'packages/core/package.json': '1.0.0' }
    );
    writeFileSync(join(repo, rel), '{ this is not JSON\n');
    const out = execFileSync(process.execPath, [scriptPath], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(out, 'true', 'a corrupt manifest must open the gate, not vanish from the walk');
  });
}

test('a parent-side manifest that is not JSON still opens the gate', (t) => {
  // The other half of the asymmetry `parseVersion` documents: it THROWS for
  // the checked-out tree, while `versionAtRev` catches — because unreadable
  // at the parent already means "cannot say it is unchanged", which is a
  // bump. Without the catch this would crash, which also fails open, so this
  // pins the *shape* of the answer as well as its direction.
  const repo = makeRepo(t, { 'package.json': '6.0.0' }, { 'package.json': '6.0.0' });
  writeFileSync(join(repo, 'package.json'), '{ not JSON at the PARENT\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'corrupt parent']);
  writePackages(repo, { 'package.json': '6.0.0' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'head']);
  const result = versionChanged(repo);
  assert.equal(result.changed, true);
  assert.deepEqual(result.bumps, [{ path: 'package.json', from: null, to: '6.0.0' }]);
});

/**
 * The YAML seam. `release.yml` consumes this script's stdout, and the shell
 * there is the thing that decides whether the script's fail-open survives:
 * under `bash --noprofile --norc -eo pipefail` a bare
 * `VAR=$(node …)` takes the substitution's exit status, so any non-zero exit
 * kills the whole STEP, `version_changed` is never written, `verify` reads
 * `''`, and both verifiers skip DESPITE `always()` — the exact failure the
 * step's placement exists to prevent. An exit-0 run that printed nothing
 * writes `version_changed=` and skips just as silently, with a green check.
 *
 * The lines are LIFTED FROM `release.yml` rather than restated, so editing
 * the workflow back to the fragile spelling reddens this test.
 */
const releaseWorkflow = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'release.yml');

function versionChangedStepScript() {
  const lines = readFileSync(releaseWorkflow, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*VERSION_CHANGED=/.test(l));
  const end = lines.findIndex((l) => /^\s*echo "version_changed=/.test(l));
  assert.ok(start !== -1 && end !== -1 && end >= start, 'the version_changed lines must exist in release.yml');
  const indent = lines[start].match(/^\s*/)[0];
  return lines
    .slice(start, end + 1)
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    .join('\n');
}

for (const [name, stub] of [
  ['the script exits NON-ZERO', 'process.stderr.write("boom\\n"); process.exit(7);'],
  ['the script exits 0 printing NOTHING', 'process.exit(0);'],
  ['the script cannot be found at all', null],
]) {
  test(`the release.yml step still writes version_changed=true when ${name}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ifclite-version-seam-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (stub !== null) {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'release-version-changed.mjs'), `${stub}\n`);
    }
    const stepPath = join(dir, 'step.sh');
    writeFileSync(stepPath, versionChangedStepScript());
    const outPath = join(dir, 'github_output');
    writeFileSync(outPath, '');
    // The Actions default shell, verbatim: `bash --noprofile --norc -eo pipefail`.
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', stepPath], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: outPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const written = readFileSync(outPath, 'utf8');
    assert.match(written, /^version_changed=true$/m, `steps.pre.outputs.version_changed was ${JSON.stringify(written)}`);
  });
}

test('the release.yml step passes a real "false" through, so ordinary pushes stay quiet', (t) => {
  // The opposite direction: the seam guard must not weld the gate open.
  const dir = mkdtempSync(join(tmpdir(), 'ifclite-version-seam-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'release-version-changed.mjs'), 'process.stdout.write("false\\n");\n');
  const stepPath = join(dir, 'step.sh');
  writeFileSync(stepPath, versionChangedStepScript());
  const outPath = join(dir, 'github_output');
  writeFileSync(outPath, '');
  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', stepPath], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: outPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(readFileSync(outPath, 'utf8'), /^version_changed=false$/m);
});
