/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('the PR-Agent runner treats candidate scripts as diff data, never executable policy', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pr-agent-trust-'));
  const trusted = join(fixture, 'trusted');
  const candidate = join(fixture, 'candidate');
  const out = join(fixture, 'out');
  const sentinel = join(fixture, 'candidate-policy-ran');

  execFileSync('git', ['clone', '--quiet', '--no-local', root, trusted]);
  copyFileSync(join(root, 'scripts/review/pr-agent-run.sh'), join(trusted, 'scripts/review/pr-agent-run.sh'));
  git(trusted, 'config', 'user.email', 'test@example.invalid');
  git(trusted, 'config', 'user.name', 'PR Agent test');
  git(trusted, 'add', 'scripts/review/pr-agent-run.sh');
  git(trusted, 'commit', '--quiet', '--allow-empty', '-m', 'trusted runner under test');
  const base = git(trusted, 'rev-parse', 'HEAD');

  execFileSync('git', ['clone', '--quiet', '--no-local', trusted, candidate]);
  git(candidate, 'config', 'user.email', 'test@example.invalid');
  git(candidate, 'config', 'user.name', 'PR Agent test');
  writeFileSync(
    join(candidate, 'scripts/review/build-review-input.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'candidate policy executed');\nexport const isExcluded = () => false;\n`,
  );
  git(candidate, 'add', 'scripts/review/build-review-input.mjs');
  git(candidate, 'commit', '--quiet', '-m', 'hostile candidate policy');
  const head = git(candidate, 'rev-parse', 'HEAD');

  const run = spawnSync(
    'bash',
    [join(trusted, 'scripts/review/pr-agent-run.sh'), base, head, out, candidate],
    { cwd: trusted, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: join(fixture, 'github-output') } },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(sentinel), false, 'candidate policy was executed');
  assert.ok(statSync(join(out, 'pr.diff')).size > 0, 'candidate diff was not produced');
});
