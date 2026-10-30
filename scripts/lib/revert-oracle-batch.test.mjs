/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationInvocations } from './revert-oracle-batch.mjs';
import { parseRevertOracleArgs } from './revert-oracle-args.mjs';

const oracle = fileURLToPath(new URL('../check-test-revert-oracle.mjs', import.meta.url));
function fixture(t, second = 'observed') {
  const root = mkdtempSync(join(tmpdir(), 'oracle-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
  git('init', '-q');
  write('package.json', '{"type":"module","scripts":{"test":"node --test scripts/*.test.mjs"}}');
  commit(); const base = git('rev-parse', 'HEAD');
  for (const name of ['a', 'b']) {
    write(`lib/${name}.mjs`, 'export const value = 1;\n');
    const assertion = name === 'b' && second === 'unobserved' ? 'assert.ok(value >= 0)' : 'assert.equal(value, 1)';
    const hang = name === 'b' && second === 'hang' ? 'if (value === 0) { process.on("SIGTERM", () => {}); setInterval(() => {}, 100); }' : '';
    write(`scripts/${name}.test.mjs`, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../lib/${name}.mjs';\n${hang}\ntest('witness ${name}', () => { ${assertion}; });\n`);
    write(`${name}.patch`, `diff --git a/lib/${name}.mjs b/lib/${name}.mjs\n--- a/lib/${name}.mjs\n+++ b/lib/${name}.mjs\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n`);
  }
  commit();
  return { root, base, git };
}

test('#7955 repeated patches keep their own witnesses and shared flags', () => {
  assert.deepEqual(mutationInvocations(['--base', 'main', '--mutation', 'a', '--test', 'ta', '--mutation', 'b', '--test', 'tb', '--ci']), [
    ['--base', 'main', '--ci', '--mutation', 'a', '--test', 'ta'],
    ['--base', 'main', '--ci', '--mutation', 'b', '--test', 'tb'],
  ]);
  assert.throws(() => parseRevertOracleArgs(['--timeout-ms', 'NaN'], (message) => { throw new Error(message); }), /positive integer/);
});

for (const second of ['observed', 'unobserved', 'hang']) {
  test(`#7955 two real mutation experiments: second ${second}, always restore and run green`, { timeout: 25000 }, (t) => {
    const f = fixture(t, second);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [oracle, '--root', f.root, '--base', f.base, '--ci', '--json', '--verify-restored', '--timeout-ms', '1500',
      '--mutation', join(f.root, 'a.patch'), '--test', 'scripts/a.test.mjs',
      '--mutation', join(f.root, 'b.patch'), '--test', 'scripts/b.test.mjs'], { cwd: f.root, env, encoding: 'utf8', timeout: 22000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    if (second === 'observed') assert.equal(result.status, 0, output);
    else assert.notEqual(result.status, 0, output);
    assert.match(output, /mutation 2\/2/);
    assert.match(output, /\[restored\].*node-test.*pass/);
    if (second === 'unobserved') assert.match(output, /UNOBSERVED/);
    if (second === 'hang') assert.match(output, /test hangs under mutation: likely leaked handle\/timer/);
    assert.equal(f.git('status', '--porcelain'), '');
  });
}

test('#7955 an explicit existing witness is executed even when this branch does not edit it', (t) => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'lib/c.mjs'), 'export const added = true;\n');
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new production file');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [oracle, '--root', f.root, '--base', base, '--ci', '--verify-restored',
    '--mutation', join(f.root, 'a.patch'), '--test', 'scripts/a.test.mjs'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git('status', '--porcelain'), '');
});
