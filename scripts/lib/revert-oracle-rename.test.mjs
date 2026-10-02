/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

function fixture({ observes = true, deleted = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rename-6663-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (bin, args) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const git = args => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Rename inverse fixture']);
    git(['config', 'user.email', 'oracle@example.invalid']);
    mkdirSync(join(root, 'src/lib'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test scripts/*.test.mjs' } }));
    // Stable helper content makes Git detect a real rename even though its
    // runtime value changes; both consumers enter through the same module.
    const padding = Array.from({ length: 24 }, (_, n) => `// Stable helper documentation ${n}.`).join('\n');
    writeFileSync(join(root, 'src/helper.mjs'), `${padding}\nexport const value = 1;\n`);
    writeFileSync(join(root, 'src/consumer.mjs'), "import { value } from './helper.mjs';\nexport const readValue = () => value;\nexport const unchanged = () => 7;\n");
    git(['add', '.']); git(['commit', '-qm', 'old helper and consumer']);
    const base = git(['rev-parse', 'HEAD']);
    if (deleted) {
      git(['rm', 'src/helper.mjs']);
      writeFileSync(join(root, 'src/consumer.mjs'), 'export const readValue = () => 2;\nexport const unchanged = () => 7;\n');
    } else {
      git(['mv', 'src/helper.mjs', 'src/lib/helper.mjs']);
      writeFileSync(join(root, 'src/lib/helper.mjs'), `${padding}\nexport const value = 2;\n`);
      writeFileSync(join(root, 'src/consumer.mjs'), "import { value } from './lib/helper.mjs';\nexport const readValue = () => value;\nexport const unchanged = () => 7;\n");
    }
    writeFileSync(join(root, 'scripts/consumer.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readValue, unchanged } from '../src/consumer.mjs';\n"
      + (observes ? "test('changed behavior', () => assert.equal(readValue(), 2));\n" : "test('non-observer', () => assert.ok(Number.isFinite(readValue())));\n")
      + "test('unchanged control', () => assert.equal(unchanged(), 7));\n");
    git(['add', '.']); git(['commit', '-qm', 'relocate helper and execute consumer assertions']);
    if (!deleted) assert.match(git(['diff', '--name-status', base, 'HEAD']), /R\d+\tsrc\/helper\.mjs\tsrc\/lib\/helper\.mjs/);
    return { root, base, run, git };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function observe(options, only = []) {
  const { root, base, run, git } = fixture(options);
  try {
    const result = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json', ...only.flatMap(path => ['--only', path])]);
    const output = result.stdout + result.stderr;
    const payload = JSON.parse(output.slice(output.lastIndexOf('\n{\n') + 1));
    assert.equal(result.status, options?.observes === false ? 1 : 0, output);
    assert.equal(payload.verdict, options?.observes === false ? 'UNOBSERVED' : 'OBSERVED', output);
    assert.equal(payload.baseline.kind, 'pass');
    assert.equal(payload.baseline.passed, 2);
    assert.equal(payload.reverted.kind, options?.observes === false ? 'pass' : 'assertion-failure');
    assert.equal(payload.reverted.passed, options?.observes === false ? 2 : 1);
    if (options?.observes !== false) assert.equal(payload.reverted.failed, 1);
    assert.equal(payload.restoration, 'verified');
    assert.equal(git(['status', '--porcelain']), '', 'forward restoration is byte-clean');
    assert.equal(existsSync(join(root, 'src/helper.mjs')), false, 'the original location is absent again after restoration');
    assert.equal(existsSync(join(root, 'src/lib/helper.mjs')), !options?.deleted);
    const restored = run(process.execPath, ['--test', 'scripts/consumer.test.mjs']);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    return payload;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('#6663: full production inverse restores both locations of a relocated helper and executes a genuine RED', () => {
  const payload = observe();
  assert.ok(payload.production.includes('src/helper.mjs'));
  assert.ok(payload.production.includes('src/lib/helper.mjs'));
});

test('#6663: selecting the new rename path also restores its old path with the selected consumer', () => {
  observe({}, ['src/consumer.mjs', 'src/lib/helper.mjs']);
});

test('#6663: selecting the original rename path also restores its new path with the selected consumer', () => {
  observe({}, ['src/consumer.mjs', 'src/helper.mjs']);
});

test('#6663: fixing rename imports does not certify assertions which ignore the behavior', () => {
  observe({ observes: false });
});

test('#6663: ordinary deleted production paths still restore and produce an attributable RED', () => {
  observe({ deleted: true });
});
