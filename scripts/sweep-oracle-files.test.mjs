/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9054: merged oracle files are removed, and what the gates still read stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./sweep-oracle-files.mjs', import.meta.url));
const SWEPT = ['tests/evidence/a/oracle.json', 'tests/evidence/a/behaviour.oracle.patch', 'tests/evidence/b c/x.oracle.patch'];
const KEPT = [
  'tests/evidence/a/witnesses.txt',
  'tests/evidence/a/nested/oracle.json',
  'tests/fixtures/oracle.json',
  'apps/report-service/test/fixtures/keep.oracle.patch',
];

function repo(t, paths) {
  const root = mkdtempSync(join(tmpdir(), 'sweep-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'README.md'), 'x\n');
  for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), `${path}\n`); }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, git };
}
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });

test('--apply removes merged oracle files and keeps everything else', t => {
  const { root, git } = repo(t, [...SWEPT, ...KEPT]);
  const result = run(root, '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 merged oracle file\(s\) removed/);
  for (const path of SWEPT) assert.equal(existsSync(join(root, path)), false, path);
  for (const path of KEPT) assert.equal(existsSync(join(root, path)), true, path);
  assert.deepEqual(git('diff', '--cached', '--name-only', '--no-renames', '-z').split('\0').filter(Boolean).sort(), [...SWEPT].sort());
});

test('without --apply it only lists', t => {
  const { root, git } = repo(t, [...SWEPT, ...KEPT]);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('tests/evidence/a/oracle.json'));
  assert.equal(git('status', '--porcelain'), '');
});

test('--apply with nothing to sweep changes nothing', t => {
  const { root, git } = repo(t, KEPT);
  const result = run(root, '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 merged oracle file/);
  assert.equal(git('status', '--porcelain'), '');
});
