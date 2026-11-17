/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9054: the retired evidence trees stay empty, and the gates' own inputs stay allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-no-retained-evidence.mjs', import.meta.url));

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'retained-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const write = path => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), `${path}\n`); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  write('README.md');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'pr');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'change'); };
  const gate = () => spawnSync(process.execPath, [SCRIPT, '--base', 'main'], { cwd: root, encoding: 'utf8' });
  return { root, write, commit, gate };
}

for (const path of [
  'docs/architecture/evidence/9088-glass/README.md',
  'scripts/perf/evidence/cohort-1/receipts.tar.gz',
  'tests/e2e/evidence/shot.png',
  'tests/ui-scenes/command-palette/evidence/shot.png',
  'tools/ifcopenshell_reference/evidence/log.gz',
  'tests/evidence/slice/receipt.json',
  'tests/evidence/slice/nested/witnesses.txt',
]) {
  test(`refuses an added ${path}`, t => {
    const f = repo(t);
    f.write(path); f.commit();
    const result = f.gate();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /RETAINED_EVIDENCE: 1 added/);
    assert.ok(result.stderr.includes(path));
  });
}

for (const path of [
  'tests/evidence/slice/witnesses.txt',
  'tests/evidence/slice/oracle.json',
  'tests/evidence/slice/behaviour.oracle.patch',
  'tests/fixtures/appearance/page.json',
  'apps/viewer/src/lib/assistant/evidence/capture.ts',
]) {
  test(`allows an added ${path}`, t => {
    const f = repo(t);
    f.write(path); f.commit();
    const result = f.gate();
    assert.equal(result.status, 0, result.stderr);
  });
}

test('a rename into a retired tree counts as adding it', t => {
  const f = repo(t);
  f.write('notes/receipt.json'); f.commit();
  // Compare from the commit that already has the file, so only the move is new.
  execFileSync('git', ['branch', '-f', 'main'], { cwd: f.root });
  mkdirSync(join(f.root, 'docs/architecture/evidence/x'), { recursive: true });
  renameSync(join(f.root, 'notes/receipt.json'), join(f.root, 'docs/architecture/evidence/x/receipt.json'));
  f.commit();
  assert.equal(f.gate().status, 1);
});

test('deleting from a retired tree is allowed', t => {
  const f = repo(t);
  f.write('docs/architecture/evidence/x/old.png'); f.commit();
  execFileSync('git', ['branch', '-f', 'main'], { cwd: f.root });
  rmSync(join(f.root, 'docs/architecture/evidence/x/old.png'));
  f.commit();
  assert.equal(f.gate().status, 0);
});

test('fails closed when git cannot compare', t => {
  const f = repo(t);
  const result = spawnSync(process.execPath, [SCRIPT, '--base', 'no-such-ref'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NO_DIFF/);
});
