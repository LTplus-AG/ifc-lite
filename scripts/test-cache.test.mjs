/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { CACHE_SUITES, cachePlan } from './test-cache.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const turbo = require.resolve('turbo/bin/turbo');
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const json = (path, value) => write(path, JSON.stringify(value));
const command = (cwd, cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ifc-test-cache-proof-'));
  json(join(root, 'package.json'), { name: 'cache-proof', private: true, packageManager: 'pnpm@10.8.1' });
  write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  write(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  write(join(root, '.gitignore'), 'node_modules/\ndist/\n.turbo/\n.executions\n');
  for (const name of ['tsconfig.json', 'tsconfig.packages.json', 'tsconfig.tests.base.json']) {
    json(join(root, name), {});
  }
  // Run the real installed Vitest, with real test assertions and an execution
  // counter. The temporary workspace never edits the shared checkout's source.
  const vitestRequire = createRequire(join(repository, 'packages/embed-protocol/package.json'));
  const vitestRoot = dirname(vitestRequire.resolve('vitest/package.json'));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(vitestRoot, join(root, 'node_modules/vitest'), 'dir');
  symlinkSync(dirname(require.resolve('turbo/package.json')), join(root, 'node_modules/turbo'), 'dir');
  symlinkSync(join(vitestRoot, 'vitest.mjs'), join(root, 'node_modules/.bin/vitest'));
  const config = JSON.parse(readFileSync(join(repository, 'turbo.json'), 'utf8'));
  // A declared passthrough value proves it too enters the guarded cache key.
  config.globalPassThroughEnv.push('CACHE_PROOF_FAILURE');
  json(join(root, 'turbo.json'), config);
  for (const suite of [...CACHE_SUITES, 'uncached-proof']) {
    const pkg = join(root, 'packages', suite);
    json(join(pkg, 'package.json'), {
      name: `@ifc-lite/${suite}`, scripts: { build: 'node build.mjs', test: 'vitest run' },
    });
    write(join(pkg, 'build.mjs'), "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('dist',{recursive:true}); writeFileSync('dist/ready','built');\n");
    write(join(pkg, 'src/input.txt'), '1');
    write(join(pkg, 'test/invariant.test.mjs'), `
import {test, expect} from 'vitest';
import {appendFileSync, readFileSync} from 'node:fs';
test('dependency builds precede execution and the invariant holds', () => {
  appendFileSync('.executions', 'executed\\n');
  expect(readFileSync('dist/ready', 'utf8')).toBe('built');
  expect(Number(readFileSync('src/input.txt', 'utf8'))).toBeGreaterThan(0);
  expect(process.env.CACHE_PROOF_FAILURE).not.toBe('1');
});
`);
  }
  command(root, 'git', ['init', '-q']);
  command(root, 'git', ['add', '.']);
  return root;
}

const identityEnv = () => ({
  ...process.env,
  npm_config_user_agent: `pnpm/10.8.1 npm/? node/${process.version} ${process.platform} ${process.arch}`,
  NODE_OPTIONS: '',
  NODE_PATH: '',
});
// node:test itself may add execArgv on some Node versions; model the production
// launcher, which starts as plain `node scripts/test-cache.mjs`.
const runtime = { ...process, execArgv: [] };

function dry(root, env, args = []) {
  const flags = ['--filter=@ifc-lite/embed-protocol', '--dry-run=json', ...args];
  const plan = cachePlan(root, flags, env, runtime);
  const path = join(root, '.turbo/proof-config.json');
  json(path, plan.config);
  const result = JSON.parse(command(root, process.execPath,
    [turbo, 'test', `--root-turbo-json=${path}`, ...flags], plan.env));
  return result.tasks.find((t) => t.task === 'test');
}

test('selective cache hashes actual Turbo inputs and fails closed without runtime identity', () => {
  const root = fixture();
  try {
    const env = identityEnv();
    const initial = dry(root, env);
    assert.equal(cachePlan(root, [], env, runtime).env.IFC_LITE_TEST_CACHE_IDENTITY,
      cachePlan(root, ['--dry-run=json'], env, runtime).env.IFC_LITE_TEST_CACHE_IDENTITY);
    assert.equal(initial.resolvedTaskDefinition.cache, true);
    assert.deepEqual(initial.dependencies, ['@ifc-lite/embed-protocol#build']);
    assert.equal(dry(root, env).hash, initial.hash);
    for (const [name, value] of [
      ['TEST_PATTERN', 'one'], ['TEST_SHARD', '1'], ['TEST_SHARDS', '2'],
      ['TZ', 'Etc/UTC'], ['CACHE_PROOF_FAILURE', '1'],
    ]) assert.notEqual(dry(root, { ...env, [name]: value }).hash, initial.hash, name);
    const selected = dry(root, { ...env, TEST_PATTERN: 'needle', TEST_SHARD: '1', TEST_SHARDS: '4' });
    assert.deepEqual([...selected.environmentVariables.specified.env].sort(),
      ['IFC_LITE_TEST_CACHE_IDENTITY', 'TEST_PATTERN', 'TEST_SHARD', 'TEST_SHARDS']);
    assert.equal(selected.environmentVariables.configured.length, 4);
    for (const path of [
      'packages/embed-protocol/src/input.txt', 'packages/embed-protocol/test/invariant.test.mjs',
      'packages/embed-protocol/vitest.config.ts', 'packages/embed-protocol/tsconfig.json',
      'packages/embed-protocol/build.mjs', 'tsconfig.json', 'tsconfig.packages.json',
      'packages/embed-protocol/.env.test', '.env.test',
      'tsconfig.tests.base.json', 'pnpm-lock.yaml', 'package.json',
    ]) {
      const full = join(root, path);
      let original;
      try { original = readFileSync(full); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      write(full, original === undefined ? '// new input\n' : `${original}\n`);
      assert.notEqual(dry(root, env).hash, initial.hash, path);
      if (original === undefined) rmSync(full); else write(full, original);
    }
    const absent = { ...env };
    delete absent.npm_config_user_agent;
    assert.equal(dry(root, absent).resolvedTaskDefinition.cache, false);
    assert.equal(dry(root, { ...env, npm_config_user_agent: 'pnpm/10.8.1' }).resolvedTaskDefinition.cache, false);
    assert.equal(dry(root, { ...env, NODE_OPTIONS: '--no-warnings' }).resolvedTaskDefinition.cache, false);
    assert.equal(dry(root, env, ['--env-mode=loose']).resolvedTaskDefinition.cache, false);
    assert.equal(cachePlan(root, ['--', '--config=/external/config.ts'], env, runtime).eligible, false);
    const manifest = join(root, 'packages/embed-protocol/package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    json(manifest, { ...pkg, dependencies: { '@ifc-lite/geometry': 'workspace:*' } });
    assert.equal(dry(root, env).resolvedTaskDefinition.cache, false);
    json(manifest, pkg);
    const otherEnv = { ...env, npm_config_user_agent: `pnpm/10.8.1 npm/? node/${process.version} ${process.platform} different` };
    const other = cachePlan(root, [], otherEnv, { ...runtime, arch: 'different' });
    assert.equal(other.eligible, true);
    assert.notEqual(cachePlan(root, [], env, runtime).env.IFC_LITE_TEST_CACHE_IDENTITY,
      other.env.IFC_LITE_TEST_CACHE_IDENTITY);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real Turbo cold/warm runs cache only audited suites and invalidate successful results', () => {
  const root = fixture();
  try {
    const args = ['--concurrency=1', '--cache=local:rw', '--continue=always'];
    const execute = (env = identityEnv(), expectedStatus = 0) => {
      const plan = cachePlan(root, args, env, runtime);
      const config = join(root, '.turbo/proof-config.json');
      json(config, plan.config);
      const result = spawnSync(process.execPath,
        [turbo, 'test', `--root-turbo-json=${config}`, ...args],
        { cwd: root, env: plan.env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
      return result.stdout;
    };
    const count = (suite) => readFileSync(join(root, 'packages', suite, '.executions'), 'utf8').trim().split('\n').length;
    execute();
    execute();
    for (const suite of CACHE_SUITES) assert.equal(count(suite), 1, suite);
    assert.equal(count('uncached-proof'), 2);
    write(join(root, 'packages/embed-protocol/src/input.txt'), '2');
    execute();
    assert.equal(count('embed-protocol'), 2);
    assert.equal(count('report-contract'), 1);
    const absent = identityEnv();
    delete absent.npm_config_user_agent;
    execute(absent);
    assert.equal(count('embed-protocol'), 3, 'unidentified runtime must execute');
    assert.equal(count('report-contract'), 2, 'unidentified runtime must execute');
    const failedEnv = { ...identityEnv(), CACHE_PROOF_FAILURE: '1' };
    execute(failedEnv, 1);
    const failedCount = count('embed-protocol');
    execute(failedEnv, 1);
    assert.ok(count('embed-protocol') > failedCount, 'failures must execute again');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PID-directed cancellation stops Turbo tasks and returns the interrupt status', { timeout: 20_000 }, async t => {
  if (process.platform === 'win32') { t.skip('POSIX SIGINT delivery; Windows uses task termination'); return; }
  const root = fixture();
  const pkg = join(root, 'packages/embed-protocol');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  json(join(pkg, 'package.json'), { ...manifest, scripts: { ...manifest.scripts, test: 'node wait.mjs' } });
  write(join(pkg, 'wait.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('worker.pid', String(process.pid));
setInterval(() => {}, 1000);
`);
  write(join(root, 'launch.mjs'), `import {runTests} from ${JSON.stringify(new URL('./test-cache.mjs', import.meta.url).href)};
process.exitCode = await runTests(process.cwd(), process.argv.slice(2));
`);
  const child = spawn(process.execPath, [join(root, 'launch.mjs'),
    '--filter=@ifc-lite/embed-protocol', '--concurrency=1'], {
    cwd: root, env: identityEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let pid;
  const exited = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => accept({ code, signal }));
  });
  const alive = value => {
    try { process.kill(value, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { pid = Number(readFileSync(join(pkg, 'worker.pid'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(accept => setTimeout(accept, 20));
    }
    assert.ok(pid, `long-running task never started: ${output}`);
    assert.equal(alive(pid), true);
    child.kill('SIGINT');
    const outcome = await Promise.race([exited,
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`cancellation hung: ${output}`)), 5000); timer.unref(); }),
    ]);
    assert.equal(outcome.code, 130, output);
    assert.equal(alive(pid), false, 'the task process must stop along with the launcher');
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
