/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof for `scripts/check-release-late-changesets.mjs` (#5647):
 * the merge-queue gate and Release backstop against a release commit that
 * still carries a pending changeset.
 *
 * Every case is a REAL throwaway git repository, because the verdict is a
 * comparison against a base revision and a stubbed git would prove nothing
 * about it. Only the CLI is driven, as a child process: its exit status and
 * `--record` line are the whole interface both workflows consume.
 *
 * Every case asserts the exit STATUS first, and checks stderr with
 * `assert.ok(re.test(...))` rather than `assert.match`, which echoes the
 * input on failure. Both are load-bearing for the revert oracle (`Changed
 * tests observe production`): with the script reverted away, node exits 1
 * with "Cannot find module" on stderr, and echoing that text would make the
 * oracle read the run, rightly by its rules, as a test that never loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'check-release-late-changesets.mjs');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Apply `{ path: content | null }` to the tree: a `package.json` path takes a
 * version string, anything else takes file text; `null` deletes.
 */
function apply(repo, files) {
  for (const [rel, value] of Object.entries(files)) {
    const abs = join(repo, rel);
    if (value === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const text = rel.endsWith('package.json')
      ? `${JSON.stringify({ name: rel.replace(/\//g, '-'), version: value }, null, 2)}\n`
      : value;
    writeFileSync(abs, text);
  }
}

/** A repo whose HEAD~1 carries `before` and whose HEAD adds `after` on top. */
function makeRepo(t, before, after) {
  const repo = mkdtempSync(join(tmpdir(), 'ifclite-late-changeset-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  if (before) {
    apply(repo, before);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'before']);
  }
  apply(repo, after);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'after', '--allow-empty']);
  return repo;
}

function cli(cwd, args = []) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// main at the moment 77ace0aa6 landed: two packages, one pending changeset.
const MAIN_WITH_LATE_CHANGESET = {
  'package.json': '8.0.0',
  'packages/geometry/package.json': '7.5.0',
  'packages/parser/package.json': '8.0.0',
  '.changeset/README.md': '# Changesets\n',
  '.changeset/config.json': '{}\n',
  '.changeset/cozy-seals-knock.md': '---\n"@ifc-lite/viewer": patch\n---\n\nlate fix\n',
};

test('a release commit that still carries a pending changeset fails', (t) => {
  // 9e5994c7f's shape: the version PR consumed the changesets it knew about
  // and bumped their packages, then was squashed onto a main that had gained
  // `cozy-seals-knock.md` since its last refresh.
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/geometry/package.json': '7.5.1',
    'packages/parser/package.json': '8.2.0',
  });
  const run = cli(repo, ['--context', 'merge']);
  assert.equal(run.status, 1);
  assert.ok(/^::error title=Release commit still carries changesets/m.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.ok(/Since HEAD~1, 2 workspace version\(s\) moved:\n {2}packages\/geometry\/package\.json: 7\.5\.0 -> 7\.5\.1\n {2}packages\/parser\/package\.json: 8\.0\.0 -> 8\.2\.0\n/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.ok(/1 pending changeset\(s\):\n {2}\.changeset\/cozy-seals-knock\.md\n/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.ok(/queue it again/.test(run.stderr), 'the merge remedy tells the operator to refresh and re-queue');

  const release = cli(repo, ['--context', 'release']);
  assert.equal(release.status, 1);
  assert.ok(/published NOTHING/.test(release.stderr), 'stderr lacks the expected text (not echoed; see the header)');
});

test('a release commit that consumed every changeset passes', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/geometry/package.json': '7.5.1',
    '.changeset/cozy-seals-knock.md': null,
  });
  const run = cli(repo);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'release commit (1 version bump(s)) with no pending changesets\n');
});

test('an ordinary commit that adds a changeset passes', (t) => {
  // The ~50-a-day case: pending changesets are normal on main, and the gate
  // must stay out of their way.
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/geometry/src/index.ts': 'export const fixed = true;\n',
    '.changeset/another-fix.md': '---\n"@ifc-lite/geometry": patch\n---\n\nfix\n',
  });
  const run = cli(repo);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'no version bump since HEAD~1 (2 pending changeset(s))\n');
});

test('an ordinary commit that ADDS a workspace package with its changeset passes', (t) => {
  // A new package is a "bump" to the publish verifiers (its first publish
  // must be checked) but it is not a release commit; with its changeset it is
  // the normal shape of an ordinary PR.
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/brand-new/package.json': '0.1.0',
    '.changeset/brand-new.md': '---\n"packages-brand-new-package.json": minor\n---\n\nnew\n',
  });
  const run = cli(repo);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'no version bump since HEAD~1 (2 pending changeset(s))\n');
});

test('files @changesets/read ignores are not pending changesets', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/geometry/package.json': '7.5.1',
    '.changeset/cozy-seals-knock.md': null,
    '.changeset/Readme.md': 'README in any case\n',
    '.changeset/AGENTS.md': 'agent notes\n',
    '.changeset/CLAUDE.md': 'agent notes\n',
    '.changeset/GEMINI.md': 'agent notes\n',
    '.changeset/.hidden.md': 'dotfile\n',
    '.changeset/pre/nested.md': 'pre-mode dir is not read\n',
  });
  const run = cli(repo);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'release commit (1 version bump(s)) with no pending changesets\n');
});

test('a Version Packages commit and a later changeset in ONE push fail against the push base', (t) => {
  // The merge queue lands up to five entries in one push and Release runs
  // once, on the tip. Here the Version Packages entry is clean on its own
  // (HEAD~1), and the entry behind it adds a changeset (HEAD). Against HEAD~1
  // the tip looks ordinary; against the push base it is a release that
  // publishes nothing.
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {
    'packages/geometry/package.json': '7.5.1',
    '.changeset/cozy-seals-knock.md': null,
  });
  apply(repo, { '.changeset/behind-in-queue.md': '---\n"@ifc-lite/parser": patch\n---\n\nfix\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'ordinary PR queued behind the version PR']);

  const alone = cli(repo);
  assert.equal(alone.status, 0, 'HEAD~1 alone cannot see the batch');
  const run = cli(repo, ['--base', 'HEAD~2', '--context', 'push']);
  assert.equal(run.status, 1);
  assert.ok(/Since HEAD~2, 1 workspace version\(s\) moved/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.ok(/\.changeset\/behind-in-queue\.md/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.ok(/merge the refreshed PR on its own/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
});

test('an unreadable --base refuses (exit 2)', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {});
  const run = cli(repo, ['--base', '0123456789abcdef0123456789abcdef01234567']);
  assert.equal(run.status, 2);
  assert.ok(/is not readable/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
  assert.equal(cli(repo, ['--base']).status, 2, 'a --base without a value is a usage error');
});

test('an unreadable parent refuses (exit 2) rather than reading as clean', (t) => {
  // A depth-1 checkout: nothing to compare against. "Cannot tell" must not
  // pass, or a shallow checkout would switch the gate off silently.
  const repo = makeRepo(t, null, MAIN_WITH_LATE_CHANGESET);
  const run = cli(repo);
  assert.equal(run.status, 2);
  assert.ok(/base revision HEAD~1 is not readable/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
});

test('a tree that cannot be read refuses (exit 2)', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {});
  writeFileSync(join(repo, 'packages/geometry/package.json'), '{ not JSON\n');
  const run = cli(repo);
  assert.equal(run.status, 2);
  assert.ok(/could not be evaluated/.test(run.stderr), 'stderr lacks the expected text (not echoed; see the header)');
});

test('an unknown --context refuses (exit 2)', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {});
  assert.equal(cli(repo, ['--context', 'publish']).status, 2);
});

test('--record appends the status to the given file and exits 0, whatever the verdict', (t) => {
  // release.yml records the verdict early, before changesets/action mutates
  // the tree, and fails at the end of the job, after the version-PR refresh.
  // So the recording step itself must not fail on a late-changeset verdict.
  const late = makeRepo(t, MAIN_WITH_LATE_CHANGESET, { 'packages/geometry/package.json': '7.5.1' });
  const clean = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {});
  const shallow = makeRepo(t, null, MAIN_WITH_LATE_CHANGESET);
  for (const [repo, expected] of [
    [late, '1'],
    [clean, '0'],
    [shallow, '2'],
  ]) {
    const out = join(repo, 'github_output');
    writeFileSync(out, 'earlier=kept\n');
    const run = cli(repo, ['--context', 'release', '--record', out]);
    assert.equal(run.status, 0);
    assert.equal(readFileSync(out, 'utf8'), `earlier=kept\nstatus=${expected}\n`);
  }
});

test('--record without a path refuses rather than recording nowhere', (t) => {
  const repo = makeRepo(t, MAIN_WITH_LATE_CHANGESET, {});
  assert.equal(cli(repo, ['--record']).status, 2);
});
