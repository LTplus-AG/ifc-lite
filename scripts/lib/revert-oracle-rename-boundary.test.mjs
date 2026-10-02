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
const productionPath = 'src/helper.mjs';
for (const otherPath of ['src/helper.test.mjs', 'docs/helper.mjs', 'assets/helper.svg']) {
  for (const incoming of [true, false]) {
    const oldPath = incoming ? otherPath : productionPath;
    const newPath = incoming ? productionPath : otherPath;
    test(`#6663: refuse the cross-category production rename ${oldPath} → ${newPath} before altering pinned sources`, () => {
      const root = mkdtempSync(join(tmpdir(), 'oracle-rename-boundary-6663-'));
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
        git(['config', 'user.name', 'Rename boundary fixture']);
        git(['config', 'user.email', 'oracle@example.invalid']);
        for (const path of [oldPath, newPath, 'scripts/consumer.test.mjs']) mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
        const padding = Array.from({ length: 24 }, (_, n) => `// Stable helper documentation ${n}.`).join('\n');
        writeFileSync(join(root, oldPath), `${padding}\nexport const value = 1;\n`);
        // This independently observable consumer keeps the branch executable
        // even when a helper is moved to an inert extension or test namespace.
        writeFileSync(join(root, 'src/consumer.mjs'), 'export const value = 1;\nexport const unchanged = 7;\n');
        git(['add', '.']); git(['commit', '-qm', 'before cross-category rename']);
        const base = git(['rev-parse', 'HEAD']);
        git(['mv', oldPath, newPath]);
        writeFileSync(join(root, newPath), `${padding}\nexport const value = 2;\n`);
        writeFileSync(join(root, 'src/consumer.mjs'), 'export const value = 2;\nexport const unchanged = 7;\n');
        writeFileSync(join(root, 'scripts/consumer.test.mjs'),
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value, unchanged } from '../src/consumer.mjs';\n"
          + "test('changed behavior', () => assert.equal(value, 2));\ntest('unchanged control', () => assert.equal(unchanged, 7));\n");
        git(['add', '.']); git(['commit', '-qm', 'cross-category rename and observable consumer']);
        assert.match(git(['diff', '--name-status', base, 'HEAD']), /R\d+\t/);
        const before = run(process.execPath, ['--test', 'scripts/consumer.test.mjs']);
        assert.equal(before.status, 0, before.stdout + before.stderr);
        const result = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json']);
        const output = result.stdout + result.stderr;
        const payload = JSON.parse(output.slice(output.lastIndexOf('\n{\n') + 1));
        assert.equal(result.status, 3, output);
        assert.equal(payload.verdict, 'INCONCLUSIVE', output);
        assert.match(payload.reason, /cross-category production rename/);
        assert.equal(payload.restoration, 'not-required', 'refusal precedes all working-tree mutation');
        assert.equal(payload.baseline, undefined, 'refusal is not a synthetic observation');
        assert.equal(payload.reverted, undefined);
        assert.equal(git(['status', '--porcelain']), '');
        assert.equal(existsSync(join(root, oldPath)), false);
        assert.equal(existsSync(join(root, newPath)), true);
        const after = run(process.execPath, ['--test', 'scripts/consumer.test.mjs']);
        assert.equal(after.status, 0, after.stdout + after.stderr);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
