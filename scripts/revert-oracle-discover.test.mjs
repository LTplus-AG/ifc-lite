/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverOracles, oracleArgs } from './revert-oracle-discover.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
  git('init', '-q');
  write('existing.mjs', 'export const value = 1;');
  write('tests/evidence/old/oracle.json', '{}'); // Existing manifests are not interpreted.
  commit();
  const base = git('rev-parse', 'HEAD');
  function add(slice, overrides = {}) {
    const data = { issue: 7955, key: `lib/${slice}.mjs`, mutation: `tests/evidence/${slice}/behaviour.oracle.patch`, test: `scripts/${slice}.test.mjs`, why: 'Observe the slice', ...overrides };
    write(`lib/${slice}.mjs`, 'export const value = 1;');
    write(`scripts/${slice}.test.mjs`, '');
    write(`tests/evidence/${slice}/behaviour.oracle.patch`, 'patch');
    write(`tests/evidence/${slice}/oracle.json`, JSON.stringify(data));
    return data;
  }
  return { root, git, write, commit, base, add };
}

test('#7955 discovers every ADDED slice in deterministic order and retains mutation/test pairing', (t) => {
  const f = fixture(t);
  const b = f.add('b', { test: undefined });
  const a = f.add('a');
  f.write('tests/evidence/old/oracle.json', '{broken on purpose');
  f.commit();
  assert.deepEqual(oracleArgs(discoverOracles(f.root, f.base)), ['--mutation', a.mutation, '--test', a.test, '--mutation', b.mutation]);
  f.write('tests/evidence/uncommitted/oracle.json', '{}');
  assert.equal(discoverOracles(f.root, f.base).length, 2);
});

for (const [name, overrides, message] of [
  ['test key', { key: 'scripts/a.test.mjs' }, /production file/],
  ['existing key', { key: 'existing.mjs' }, /not ADDED/],
  ['missing patch', { mutation: 'absent.patch' }, /mutation .*unavailable/],
  ['missing witness', { test: 'absent.test.mjs' }, /test .*unavailable/],
  ['wrong issue', { issue: 1 }, /issue must be 7955/],
  ['blank explanation', { why: ' ' }, /why must/],
  ['multiline explanation', { why: 'one\ntwo' }, /why must/],
  ['escaping patch', { mutation: '../outside.patch' }, /repository-relative/],
]) {
  test(`#7955 rejects ${name} loudly with a remedy`, (t) => {
    const f = fixture(t); f.add('a', overrides); f.commit();
    assert.throws(() => discoverOracles(f.root, f.base), (error) => message.test(error.message) && error.message.includes('Remedy:'));
  });
}

test('#7955 invalid JSON and symlink escapes fail rather than disappearing from discovery', (t) => {
  const f = fixture(t); f.add('a'); f.write('tests/evidence/a/oracle.json', '{'); f.commit();
  assert.throws(() => discoverOracles(f.root, f.base), /invalid JSON/);
  f.add('a');
  rmSync(join(f.root, 'tests/evidence/a/behaviour.oracle.patch'));
  symlinkSync(tmpdir(), join(f.root, 'tests/evidence/a/behaviour.oracle.patch'));
  f.commit();
  assert.throws(() => discoverOracles(f.root, f.base), /escapes|not a file/);
  assert.throws(() => discoverOracles(f.root, 'missing-ref'));
});
