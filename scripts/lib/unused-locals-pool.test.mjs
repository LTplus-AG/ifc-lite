/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['scripts/check-unused-locals.mjs', 'scripts/typecheck-tests.mjs', 'tsconfig.tests.base.json',
  'scripts/lib/is-main-entry.mjs', 'scripts/lib/unused-locals-classify.mjs',
  'scripts/lib/unused-locals-measure.mjs', 'scripts/lib/unused-locals-pool.mjs', 'scripts/lib/unused-locals-worker.mjs'];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'unused-locals-7546-'));
  try {
    // Run the real gate source in a disposable genuine pnpm workspace. No
    // compiler output/count is mocked, and no production source is mutated.
    for (const source of sources) {
      const target = join(root, source);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(sourceRoot, source), target);
    }
    await symlink(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'unused-locals-controls', private: true, packageManager: 'pnpm@10.8.1' }));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      const dir = join(root, 'packages', name);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `control-${name}`, version: '1.0.0', private: true }));
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, target: 'ES2020', module: 'ESNext', types: [] }, include: ['src/**/*'], exclude: ['**/*.test.ts'] }));
      await writeFile(join(dir, 'src/index.ts'), 'export const used = 1;\n');
    }
    const baseline = { 'packages/alpha': 1, 'packages/beta': 0, 'packages/delta': 0, 'packages/gamma': 2 };
    // The test-only diagnostic MUST be counted despite the emit exclusion.
    await writeFile(join(root, 'packages/alpha/src/count.test.ts'), 'const unusedTest = 1; export {};\n');
    await writeFile(join(root, 'packages/gamma/src/index.ts'), 'const unusedOne = 1; const unusedTwo = 2; export {};\n');
    await writeFile(join(root, 'scripts/unused-locals-baseline.json'), JSON.stringify(baseline) + '\n');
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

async function gate() {
  const started = [], pids = [], pending = new Set();
  let maximum = 0;
  const watchdogs = new Set();
  const release = () => { for (const response of pending) response.end('continue'); pending.clear(); };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    started.push(decodeURIComponent(url.pathname.slice(1)));
    pids.push(Number(url.searchParams.get('pid')));
    pending.add(response); maximum = Math.max(maximum, pending.size);
    if (pending.size === 2) {
      const timer = setTimeout(() => { watchdogs.delete(timer); release(); }, 500);
      watchdogs.add(timer);
    }
    else {
      // A serial inverse still runs its actual compilers; it finishes with
      // maximum=1 and fails the capacity assertion, rather than hanging.
      const timer = setTimeout(() => { watchdogs.delete(timer); release(); }, 1000);
      watchdogs.add(timer);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { started, pids, get maximum() { return maximum; }, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { release(); for (const timer of watchdogs) clearTimeout(timer); await new Promise(resolve => server.close(resolve)); } };
}

function run(root, args = [], env = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [join(root, 'scripts/check-unused-locals.mjs'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}
function assertWorkersStopped(control) {
  for (const pid of control.pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(process.platform === 'win32' ? pid : -pid, 0), { code: 'ESRCH' },
      'settled worker must leave no owned compiler process group');
  }
}
const baselineBytes = root => readFile(join(root, 'scripts/unused-locals-baseline.json'), 'utf8');
const gateEnv = control => ({ NODE_OPTIONS: `--import=${fileURLToPath(new URL('./fixtures/unused-locals-held-worker.mjs', import.meta.url))}`,
  UNUSED_LOCALS_GATE: control.url });

// Tests are serial within this file; each compiler workload is only four tiny
// programs and two genuine children, not the repository's full lint graph.
test('#7546 two real compiler workers cover every source/test package and preserve baseline bytes', { timeout: 60000 }, async () => {
  const root = await workspace(), control = await gate();
  try {
    const before = await baselineBytes(root);
    const result = await run(root, [], gateEnv(control));
    assert.equal(result.error, null, result.stdout + result.stderr);
    assert.match(result.stdout, /No new unused locals \(4 packages, 3 known, none increased\)/);
    assert.equal(control.maximum, 2, 'actual held worker births must overlap at two, never exceed two');
    assert.deepEqual(control.started.sort(), ['packages/alpha', 'packages/beta', 'packages/delta', 'packages/gamma']);
    assert.equal(await baselineBytes(root), before);
    assertWorkersStopped(control);
  } finally { await control.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [name, source, expected] of [
  ['regression', 'const newUnused = 1; export {};\n', /Unused locals\/imports increased/],
  ['unmeasurable', 'export const broken: number = "not a number";\n', /do not compile standalone/],
]) {
  test(`#7546 real TypeScript ${name} prevents any partial baseline update`, { timeout: 60000 }, async () => {
    const root = await workspace();
    try {
      const before = await baselineBytes(root);
      await writeFile(join(root, 'packages/beta/src/index.ts'), source);
      const result = await run(root);
      assert.ok(result.error, 'the actual ratchet must refuse');
      assert.match(result.stderr, expected);
      assert.equal(await baselineBytes(root), before);
      if (name === 'unmeasurable') {
        const update = await run(root, ['--update']);
        assert.ok(update.error); assert.match(update.stderr, /Not writing a baseline/);
        assert.equal(await baselineBytes(root), before);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('#7546 killed real package child still awaits all discovered outcomes and refuses update', { timeout: 60000 }, async () => {
  const root = await workspace(), control = await gate();
  try {
    const before = await baselineBytes(root);
    const result = await run(root, ['--update'], { ...gateEnv(control), UNUSED_LOCALS_KILL_PACKAGE: 'packages/alpha' });
    assert.ok(result.error);
    assert.match(result.stderr, /worker failed for packages\/alpha; no count is accepted/);
    assert.match(result.stderr, /did not measure every package/);
    assert.deepEqual(control.started.sort(), ['packages/alpha', 'packages/beta', 'packages/delta', 'packages/gamma']);
    assert.equal(await baselineBytes(root), before);
    assertWorkersStopped(control);
  } finally { await control.close(); await rm(root, { recursive: true, force: true }); }
});


test('#7546 a genuine compiler spawn failure cannot become a zero count or baseline update', { timeout: 60000 }, async () => {
  const root = await workspace(), control = await gate();
  try {
    const before = await baselineBytes(root);
    const result = await run(root, ['--update'], { ...gateEnv(control), UNUSED_LOCALS_FAIL_EXEC_PACKAGE: 'packages/beta' });
    assert.ok(result.error);
    assert.match(result.stderr, /spawn failed with ENOENT/);
    assert.deepEqual(control.started.sort(), ['packages/alpha', 'packages/beta', 'packages/delta', 'packages/gamma']);
    assert.equal(await baselineBytes(root), before);
    assertWorkersStopped(control);
  } finally { await control.close(); await rm(root, { recursive: true, force: true }); }
});

test('#7546 baseline update writes only the complete real four-package census in discovered order', { timeout: 60000 }, async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, 'scripts/unused-locals-baseline.json'), '{}\n');
    const result = await run(root, ['--update']);
    assert.equal(result.error, null, result.stdout + result.stderr);
    assert.match(result.stdout, /4 measured, 3 known violations/);
    assert.equal(await baselineBytes(root), JSON.stringify({
      'packages/alpha': 1, 'packages/beta': 0, 'packages/delta': 0, 'packages/gamma': 2,
    }, null, 2) + '\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
