/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

test('#4036: root Node assertions run through retained benchmark scaffolding after production revert', { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-root-scaffolding-'));
  const env = { ...process.env };
  // The nested fixture owns a separate Node test run, not this test runner's IPC.
  delete env.NODE_TEST_CONTEXT;
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    for (const dir of ['src', 'scripts', 'tests/benchmark']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'turbo test' } }));
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'tests/benchmark/helper.mjs'), 'export const oldHelper = true;\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
    // This new helper export must survive reversion. Reverting scaffolding
    // would produce a load failure instead of the required assertion failure.
    writeFileSync(join(root, 'tests/benchmark/helper.mjs'), "export { value as observedValue } from '../../src/value.mjs';\n");
    writeFileSync(join(root, 'scripts/value.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { observedValue } from '../tests/benchmark/helper.mjs';\ntest('observes production through helper', () => assert.equal(observedValue, 2));\n");
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production, helper and assertion']);
    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json']);
    assert.match(output, /OBSERVED/);
    assert.match(output, /1 assertion\(s\) RED out of 1 collected/);
    assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');

    // A real unsupported entrypoint must not disappear when helpers are filtered.
    writeFileSync(join(root, 'tests/benchmark/unsupported.spec.ts'), 'throw new Error("requires a declared runner");\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'add unsupported actual root test']);
    const rejected = spawnSync(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(rejected.error, undefined);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /no runner could be derived/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
