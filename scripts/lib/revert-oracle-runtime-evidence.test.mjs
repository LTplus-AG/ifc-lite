/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const oracle = join(repo, 'scripts/check-test-revert-oracle.mjs');

function resultPayload(output) {
  const start = output.indexOf('{');
  for (let end = output.indexOf('\n}', start); end !== -1; end = output.indexOf('\n}', end + 2)) {
    try {
      return JSON.parse(output.slice(start, end + 2));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error(`oracle output contained no complete result payload:\n${output}`);
}

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (bin, args, expected = 0, options = {}) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Revert oracle fixture']);
  run('git', ['config', 'user.email', 'oracle@example.invalid']);
  return { root, env, run };
}

test('#4109: a Vitest substring match cannot impersonate the requested test file', { timeout: 60_000 }, () => {
  const { root, run } = fixture('oracle-vitest-identity-');
  try {
    mkdirSync(join(root, 'packages/probe/src'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    writeFileSync(join(root, 'packages/probe/package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(root, 'packages/probe/src/value.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'packages/probe/src/probe.test.ts'), "import { test, expect } from 'vitest';\nimport { value } from './value';\ntest.skip('requested witness', () => expect(value).toBe(1));\n");
    writeFileSync(join(root, 'packages/probe/src/probe.test.tsx'), "import { test, expect } from 'vitest';\ntest('substring neighbor', () => expect(true).toBe(true));\n");
    symlinkSync(join(repo, 'packages/pointcloud/node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'packages/probe/src/value.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'packages/probe/src/probe.test.ts'), "import { test, expect } from 'vitest';\nimport { value } from './value';\ntest.skip('requested witness', () => expect(value).toBe(2));\n");
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production and skipped witness']);

    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], 3);
    const payload = resultPayload(output);
    assert.equal(payload.verdict, 'BASELINE-BROKEN');
    assert.equal(payload.ledger.some((entry) => entry.file.endsWith('probe.test.ts') && entry.baseline?.attributed === false), true);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4109: failed cleanliness verification remains RESTORE-FAILED', { timeout: 60_000 }, () => {
  const { root, env, run } = fixture('oracle-restore-state-');
  const shim = mkdtempSync(join(tmpdir(), 'oracle-git-shim-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'src/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
    writeFileSync(join(root, 'src/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('value', () => assert.equal(value, 2));\n");
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production and witness']);

    const realGit = process.platform === 'win32'
      ? spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0]
      : spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const shimScript = join(shim, 'git-shim.cjs');
    writeFileSync(shimScript, "const { spawnSync } = require('node:child_process');\nconst { writeFileSync } = require('node:fs');\nconst args = process.argv.slice(2);\nconst result = spawnSync(process.env.ORACLE_REAL_GIT, args, { stdio: 'inherit' });\nif (result.status === 0 && args.includes('apply') && !args.includes('-R')) writeFileSync('.restore-dirty', 'verification must fail\\n');\nprocess.exit(result.status ?? 1);\n");
    const shimEnv = {
      ...env,
      ORACLE_REAL_GIT: realGit,
      IFC_LITE_ORACLE_GIT_BIN: process.execPath,
      IFC_LITE_ORACLE_GIT_PREFIX: shimScript,
    };
    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], 5, { env: shimEnv });
    const payload = resultPayload(output);
    assert.equal(payload.verdict, 'RESTORE-FAILED');
    assert.equal(payload.restoration, 'failed');
    assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
    rmSync(join(root, '.restore-dirty'));
    assert.equal(run(realGit, ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
