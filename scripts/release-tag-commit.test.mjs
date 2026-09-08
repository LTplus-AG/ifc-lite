/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof for `scripts/release-tag-commit.mjs` and for the two
 * `git tag` call sites in `.github/workflows/release.yml` that consume it.
 *
 * Every case drives a REAL throwaway git repository. The defect (#3209) is
 * "`git tag` with no object tags the checkout HEAD", so a test that stubbed
 * git away would prove nothing about the thing that broke: on v6.0.1 the tag
 * landed on `a5ba0d80` ("test(mcp): a 627-line tool surface with no test
 * file") because that was the HEAD of the run that happened to reach the
 * tagging step, fourteen minutes after the version commit `989da893`.
 *
 * The workflow-seam cases below LIFT the tagging lines out of `release.yml`
 * rather than restating them, so editing the workflow back to the objectless
 * spelling reddens this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVersionCommit, tagTarget } from './release-tag-commit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'release-tag-commit.mjs');
const releaseWorkflow = join(here, '..', '.github', 'workflows', 'release.yml');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function newRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'ifclite-tag-commit-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  return repo;
}

/**
 * Commit a manifest at `version`, optionally with extra fields so a commit can
 * touch the file without moving the version — the `1.16.7` shape, where 35
 * commits sit between where the tag points and where the version was set.
 */
function commitVersion(repo, rel, version, message, extra = {}) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ name: 'pkg', version, ...extra }, null, 2)}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function commitUnrelated(repo, message) {
  writeFileSync(join(repo, `${message.replace(/\W/g, '_')}.txt`), `${message}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

test('resolves the commit that BUMPED TO the version, not the newest commit reporting it', (t) => {
  // The live `v1.16.7` damage, in miniature: the version is SET once, then the
  // manifest is touched again without the version moving. The tag belongs on
  // the bump, not on the last commit that happened to touch the file, and
  // certainly not on HEAD.
  const repo = newRepo(t);
  commitVersion(repo, 'package.json', '1.16.6', 'earlier');
  const bump = commitVersion(repo, 'package.json', '1.16.7', 'chore: version packages');
  commitVersion(repo, 'package.json', '1.16.7', 'fix(release): publish clash before geometry', { sideEffects: false });
  commitUnrelated(repo, 'unrelated head');

  assert.equal(resolveVersionCommit(repo, 'package.json', '1.16.7'), bump);
  assert.notEqual(resolveVersionCommit(repo, 'package.json', '1.16.7'), git(repo, ['rev-parse', 'HEAD']));
});

test('the `git log -S` trap: the string-count spelling names the NEXT bump, this one does not', (t) => {
  // Named in #3209: `git log -S'"version": "6.0.0"'` returns the 6.0.1 bump,
  // because `-S` matches where the string COUNT changed — the commit that
  // REMOVED the 6.0.0 line qualifies exactly as much as the one that added it.
  // This case exists to keep that implementation from creeping back.
  const repo = newRepo(t);
  const v600 = commitVersion(repo, 'package.json', '6.0.0', 'chore: version packages (6.0.0)');
  const v601 = commitVersion(repo, 'package.json', '6.0.1', 'chore: version packages (6.0.1)');

  const dashS = git(repo, ['log', '--format=%H', '-S', '"version": "6.0.0"', '--', 'package.json'])
    .split('\n')
    .filter(Boolean);
  assert.ok(dashS.includes(v601), 'precondition: -S really does name the 6.0.1 bump for the 6.0.0 string');

  assert.equal(resolveVersionCommit(repo, 'package.json', '6.0.0'), v600);
  assert.equal(resolveVersionCommit(repo, 'package.json', '6.0.1'), v601);
});

test('a version set, abandoned, then set again resolves to the LATEST bump to it', (t) => {
  const repo = newRepo(t);
  commitVersion(repo, 'package.json', '2.0.0', 'first 2.0.0');
  commitVersion(repo, 'package.json', '1.9.0', 'reverted');
  const again = commitVersion(repo, 'package.json', '2.0.0', 'second 2.0.0');
  commitUnrelated(repo, 'later');
  assert.equal(resolveVersionCommit(repo, 'package.json', '2.0.0'), again);
});

test('a version that no commit ever carried is a hard failure, not a guess', (t) => {
  const repo = newRepo(t);
  commitVersion(repo, 'package.json', '1.0.0', 'only version');
  assert.throws(() => resolveVersionCommit(repo, 'package.json', '9.9.9'), /9\.9\.9/);
});

test('server-bin resolves independently of the root manifest', (t) => {
  // The two versions are usually different and therefore different commits;
  // `release.yml` resolves each from its own manifest.
  const repo = newRepo(t);
  commitVersion(repo, 'package.json', '6.0.0', 'root 6.0.0');
  const sb = commitVersion(repo, 'packages/server-bin/package.json', '1.16.7', 'server-bin 1.16.7');
  const root = commitVersion(repo, 'package.json', '6.0.1', 'root 6.0.1');
  assert.equal(resolveVersionCommit(repo, 'packages/server-bin/package.json', '1.16.7'), sb);
  assert.equal(resolveVersionCommit(repo, 'package.json', '6.0.1'), root);
});

test('tagTarget reads the commit a tag names, and null when there is no such tag', (t) => {
  const repo = newRepo(t);
  const c = commitVersion(repo, 'package.json', '1.0.0', 'v1');
  commitUnrelated(repo, 'head');
  git(repo, ['tag', 'v1.0.0', c]);
  assert.equal(tagTarget(repo, 'v1.0.0'), c);
  assert.equal(tagTarget(repo, 'v9.9.9'), null);
});

/** Run the CLI in `repo`; returns `{ status, stdout, stderr }`. */
function runCli(repo, args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the CLI prints the resolved commit and nothing else', (t) => {
  const repo = newRepo(t);
  const bump = commitVersion(repo, 'package.json', '1.0.0', 'bump');
  commitUnrelated(repo, 'head');
  const { status, stdout } = runCli(repo, ['package.json', '1.0.0', 'v1.0.0']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), bump);
});

test('an EXISTING tag on a different commit fails the run rather than being quietly reused', (t) => {
  // The second half of the maintainer's ask on #3209: the live `v1.16.7`
  // damage must surface as a red job the next time a run touches it, not be
  // silently corrected. A tag that is absent is a visible problem; a tag on
  // the wrong commit is a silent one, and everything downstream treats it as
  // authoritative.
  const repo = newRepo(t);
  const bump = commitVersion(repo, 'package.json', '1.16.7', 'bump');
  const wrong = commitUnrelated(repo, 'unrelated');
  git(repo, ['tag', 'v1.16.7', wrong]);
  const { status, stderr } = runCli(repo, ['package.json', '1.16.7', 'v1.16.7']);
  assert.notEqual(status, 0, 'a tag on the wrong commit must fail the step');
  assert.match(stderr, new RegExp(wrong));
  assert.match(stderr, new RegExp(bump));
});

test('an existing tag ALREADY on the right commit is idempotent, not an error', (t) => {
  const repo = newRepo(t);
  const bump = commitVersion(repo, 'package.json', '1.16.7', 'bump');
  commitUnrelated(repo, 'later');
  git(repo, ['tag', 'v1.16.7', bump]);
  const { status, stdout } = runCli(repo, ['package.json', '1.16.7', 'v1.16.7']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), bump);
});

/**
 * The YAML seam.
 *
 * These lift the resolve-then-tag pair out of `release.yml` and run it
 * verbatim under the Actions default shell (`bash --noprofile --norc -eo
 * pipefail`) against a throwaway repository whose HEAD is deliberately NOT the
 * version commit — the production shape of #3209.
 */
function taggingFragment(varName) {
  const lines = readFileSync(releaseWorkflow, 'utf8').split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s*${varName}=\\$\\(node scripts/release-tag-commit\\.mjs`).test(l),
  );
  assert.notEqual(start, -1, `release.yml must resolve ${varName} from scripts/release-tag-commit.mjs`);
  const end = lines.findIndex((l, i) => i >= start && /^\s*git tag\s/.test(l));
  assert.notEqual(end, -1, `release.yml must tag right after resolving ${varName}`);
  const indent = lines[start].match(/^\s*/)[0];
  return lines
    .slice(start, end + 1)
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    .join('\n');
}

for (const [label, varName, manifest, versionVar] of [
  ['root', 'VERSION_COMMIT', 'package.json', 'VERSION'],
  ['server-bin', 'SB_COMMIT', 'packages/server-bin/package.json', 'SB_VERSION'],
]) {
  /** A repo carrying the script, a 6.0.1 bump, and a LATER unrelated HEAD. */
  const seamRepo = (t) => {
    const repo = newRepo(t);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    copyFileSync(scriptPath, join(repo, 'scripts', 'release-tag-commit.mjs'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'scripts']);
    const bump = commitVersion(repo, manifest, '6.0.1', 'chore: version packages');
    const head = commitUnrelated(repo, 'test(mcp): a 627-line tool surface with no test file');
    assert.notEqual(bump, head, 'precondition: HEAD is a later, unrelated commit');
    writeFileSync(join(repo, 'step.sh'), `${taggingFragment(varName)}\n`);
    return { repo, bump, head };
  };

  const runStep = (repo) =>
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(repo, 'step.sh')], {
      cwd: repo,
      env: { ...process.env, [versionVar]: '6.0.1', TAG: 'v6.0.1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  test(`release.yml's ${label} tag lands on the version commit, not on the checkout HEAD`, (t) => {
    const { repo, bump } = seamRepo(t);
    runStep(repo);
    assert.equal(
      git(repo, ['rev-list', '-n', '1', 'v6.0.1']),
      bump,
      `the ${label} tag must name the commit the version was published from`,
    );
  });

  test(`release.yml's ${label} step fails loudly when the tag already names a different commit`, (t) => {
    const { repo, head } = seamRepo(t);
    git(repo, ['tag', 'v6.0.1', head]);
    // `-e` must kill the STEP here: the `$( )` substitution's non-zero status
    // is the step's status, and `|| true` on the `git tag` line must not
    // rescue it. A wrong tag surviving into `git push` is the defect itself.
    assert.throws(() => runStep(repo));
    assert.equal(git(repo, ['rev-list', '-n', '1', 'v6.0.1']), head, 'the wrong tag is left alone, not rewritten');
  });
}

test('neither `git tag` in release.yml is objectless', () => {
  // The ratchet for #3209 itself. `git tag <name>` with no commit-ish tags the
  // current checkout HEAD, which is the TRIGGERING commit of the run — not the
  // commit the version was published from.
  const lines = readFileSync(releaseWorkflow, 'utf8').split('\n');
  const objectless = lines
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => /^git tag\s/.test(l))
    .filter(([, l]) => {
      // `git tag <name> <commit-ish>` — two operands after the subcommand,
      // ignoring a trailing `|| true` and any comment.
      const operands = l
        .replace(/\s*(\|\||#).*$/, '')
        .trim()
        .split(/\s+/)
        .slice(2);
      return operands.length < 2;
    });
  assert.deepEqual(objectless, [], 'every `git tag` in release.yml must name the commit explicitly');
});
