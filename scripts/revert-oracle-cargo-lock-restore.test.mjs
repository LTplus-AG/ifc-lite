/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = join(ROOT, 'scripts', 'check-test-revert-oracle.mjs');

function run(cwd, bin, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', env });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture({ mutateOnRevert = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'revert-oracle-cargo-lock-'));
  const manifestTail = Array.from({ length: 10 }, (_, i) => `# stable tail ${i}\n`).join('');
  mkdirSync(join(dir, 'crates', 'a'), { recursive: true });
  mkdirSync(join(dir, 'crates', 'b'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\nmembers=["crates/a","crates/b"]\nresolver="2"\n');
  writeFileSync(join(dir, 'crates', 'a', 'Cargo.toml'), `[package]\nname="a"\nversion="0.1.0"\n\n${manifestTail}`);
  writeFileSync(join(dir, 'crates', 'b', 'Cargo.toml'), `[package]\nname="b"\nversion="0.1.0"\n\n${manifestTail}`);
  writeFileSync(join(dir, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "a"\nversion = "0.1.0"\n\n[[package]]\nname = "b"\nversion = "0.1.0"\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'oracle@example.invalid');
  git(dir, 'config', 'user.name', 'Revert Oracle');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');

  writeFileSync(join(dir, 'crates', 'a', 'Cargo.toml'), `[package]\nname="a"\nversion="0.1.0"\n\n[dependencies]\nserde="1"\n\n${manifestTail}`);
  writeFileSync(join(dir, 'crates', 'b', 'Cargo.toml'), `[package]\nname="b"\nversion="0.1.0"\n\n[dependencies]\nitoa="1"\n\n${manifestTail}`);
  writeFileSync(join(dir, 'Cargo.lock'), 'version = 4\n# serde and itoa resolved for the head manifests\n');
  const mutation = mutateOnRevert
    ? "if (!lock.includes('serde and itoa')) appendFileSync(new URL('../crates/a/Cargo.toml', import.meta.url), '\\n# post-test edit\\n');"
    : '';
  writeFileSync(join(dir, 'scripts', 'cargo-lock-observer.test.mjs'),
    `import assert from 'node:assert/strict'; import { appendFileSync, readFileSync } from 'node:fs'; import test from 'node:test'; test('head lock', () => { const lock = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8'); ${mutation} assert.match(lock, /serde and itoa/); });\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'head');
  return { dir, base };
}

test('#4592 reverts changed manifests with Cargo.lock and restores byte-clean', () => {
  const { dir, base } = fixture();
  try {
    const result = run(dir, process.execPath, [ORACLE, '--root', dir, '--base', base]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OBSERVED/);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.match(readFileSync(join(dir, 'Cargo.lock'), 'utf8'), /serde and itoa/); // @source-text-assertion-ok the temp repository's restored lockfile is subprocess output, not production source
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#4592 refuses a partial changed-manifest selection before mutation', () => {
  const { dir, base } = fixture();
  try {
    const before = readFileSync(join(dir, 'Cargo.lock'), 'utf8');
    const result = run(dir, process.execPath, [
      ORACLE, '--root', dir, '--base', base, '--only', 'crates/a/Cargo.toml',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Cargo\.lock can be reverted only with every changed Cargo\.toml/);
    assert.equal(readFileSync(join(dir, 'Cargo.lock'), 'utf8'), before);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#4592 preserves a substantive post-test edit instead of normalizing it away', () => {
  const { dir, base } = fixture({ mutateOnRevert: true });
  try {
    const result = run(dir, process.execPath, [ORACLE, '--root', dir, '--base', base]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /substantive post-test change preserved: crates\/a\/Cargo\.toml/);
    assert.match(result.stdout + result.stderr, /committing or stashing it, then rerun from a clean working tree/);
    assert.match(readFileSync(join(dir, 'crates', 'a', 'Cargo.toml'), 'utf8'), /post-test edit/); // @source-text-assertion-ok the temp repository's preserved mutation is subprocess output, not production source
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
