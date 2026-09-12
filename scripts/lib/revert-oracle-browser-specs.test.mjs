/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Playwright specs in the revert oracle's test set (#4404).
 *
 * `tests/e2e/*.e2e.spec.ts` belongs to the root package (`scripts.test` =
 * `turbo test`), so a branch with production code plus such a spec ABORTed
 * with "no runner could be derived" even though its node tests observed the
 * change (#4340 merged over that red). The spec is set aside, reported, and
 * the remaining tests still have to observe the change by themselves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isBrowserSpecSource, partitionBrowserSpecs, withoutBrowserSpecs } from './revert-oracle-inert.mjs';
import { withoutBrowserSpecs as reexported } from './revert-oracle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLAYWRIGHT = `import { test, expect, type Page } from '@playwright/test';\nimport { join } from 'node:path';\ntest('x', async ({ page }) => {});\n`;
const NODE_SPEC = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('x', () => { assert.ok(true); });\n`;

test('a spec is a browser spec exactly when it imports @playwright/test', () => {
  assert.equal(isBrowserSpecSource(PLAYWRIGHT), true);
  assert.equal(isBrowserSpecSource(NODE_SPEC), false);
  assert.equal(isBrowserSpecSource(`// mentions '@playwright/test' in a comment only\nimport { test } from 'node:test';`), false);
  assert.equal(isBrowserSpecSource(undefined), false);
});

test('the repo\'s own Playwright specs are recognised from their real source', () => {
  const real = readFileSync(join(ROOT, 'tests/e2e/appearance-face-mask.e2e.spec.ts'), 'utf8');
  assert.equal(isBrowserSpecSource(real), true);
  const smoke = readFileSync(join(ROOT, 'tests/e2e/viewer-smoke.e2e.spec.ts'), 'utf8');
  assert.equal(isBrowserSpecSource(smoke), true);
});

test('partition sets Playwright specs aside and reads only *.spec.* files', () => {
  const reads = [];
  const read = (p) => { reads.push(p); return p.startsWith('tests/e2e/') ? PLAYWRIGHT : NODE_SPEC; };
  const { runnable, browser } = partitionBrowserSpecs(
    ['apps/viewer/src/a.test.ts', 'tests/e2e/face.e2e.spec.ts', 'packages/x/src/b.spec.ts', 'scripts/lib/c.test.mjs'], read);
  assert.deepEqual(browser, ['tests/e2e/face.e2e.spec.ts']);
  assert.deepEqual(runnable, ['apps/viewer/src/a.test.ts', 'packages/x/src/b.spec.ts', 'scripts/lib/c.test.mjs']);
  assert.deepEqual(reads, ['tests/e2e/face.e2e.spec.ts', 'packages/x/src/b.spec.ts'], '*.test.* files are never read');
});

test('the dispatcher hook logs each set-aside spec and returns the runnable rest; an e2e-only branch keeps nothing', () => {
  const logged = [];
  const read = (p) => (p.endsWith('.e2e.spec.ts') ? PLAYWRIGHT : NODE_SPEC);
  const rest = withoutBrowserSpecs(['tests/e2e/x.e2e.spec.ts', 'apps/viewer/src/y.test.tsx'], read, (line) => logged.push(line));
  assert.deepEqual(rest, ['apps/viewer/src/y.test.tsx']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /set aside: tests\/e2e\/x\.e2e\.spec\.ts is a Playwright spec/);
  assert.deepEqual(withoutBrowserSpecs(['tests/e2e/x.e2e.spec.ts'], read, () => {}), [], 'nothing runnable remains: the dispatcher then reports UNOBSERVED as before');
  assert.equal(reexported, withoutBrowserSpecs, 'the dispatcher imports it through revert-oracle.mjs, which is at its frozen budget');
});

test('root-owned support modules under a set-aside spec leave with it; entrypoints and package helpers stay (#4446)', () => {
  const read = (p) => (p.endsWith('.e2e.spec.ts') ? PLAYWRIGHT : NODE_SPEC);
  const ownedByRoot = (p) => !p.startsWith('packages/') && !p.startsWith('apps/');
  const paths = [
    'tests/e2e/share.e2e.spec.ts',
    'tests/e2e/collab/relay.ts', // page object / launcher for the spec
    'tests/e2e/collab/viewer-page.ts',
    'tests/benchmark/plain.spec.ts', // root entrypoint that is NOT Playwright: stays, and keeps aborting downstream
    'scripts/lib/c.test.mjs',
    'packages/x/test/helper.ts', // package-owned helper under a dir that is not the spec's
    'apps/viewer/src/a.test.ts',
  ];
  const { runnable, browser, support } = partitionBrowserSpecs(paths, read, ownedByRoot);
  assert.deepEqual(browser, ['tests/e2e/share.e2e.spec.ts']);
  assert.deepEqual(support, ['tests/e2e/collab/relay.ts', 'tests/e2e/collab/viewer-page.ts']);
  assert.deepEqual(runnable, ['tests/benchmark/plain.spec.ts', 'scripts/lib/c.test.mjs', 'packages/x/test/helper.ts', 'apps/viewer/src/a.test.ts']);
  // Without a spec set aside, nothing is support — a changed helper alone is judged as before.
  assert.deepEqual(partitionBrowserSpecs(['tests/e2e/collab/relay.ts'], read, ownedByRoot).support, []);
  // A package-owned file under the spec's directory is never root support.
  assert.deepEqual(partitionBrowserSpecs(['tests/e2e/share.e2e.spec.ts', 'tests/e2e/pkg/helper.ts'], read, () => false).support, []);
  // Without the predicate (the default), behaviour is exactly the pre-#4446 one.
  assert.deepEqual(partitionBrowserSpecs(['tests/e2e/share.e2e.spec.ts', 'tests/e2e/collab/relay.ts'], read).runnable, ['tests/e2e/collab/relay.ts']);
  const logged = [];
  withoutBrowserSpecs(['tests/e2e/share.e2e.spec.ts', 'tests/e2e/collab/relay.ts'], read, (l) => logged.push(l), ownedByRoot);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /set aside: tests\/e2e\/collab\/relay\.ts is a root-owned support module/);
});

test('end to end: a Playwright spec with root helpers beside a real unit test is judged by the unit test (#4446)', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-browser-support-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // the nested fixture owns a separate Node test run
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    // The oracle verifies a byte-identical tree after restore; a host-level core.autocrlf would rewrite endings under it.
    run('git', ['config', 'core.autocrlf', 'false']);
    for (const dir of ['src', 'scripts', 'tests/e2e/collab']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'turbo test' } }));
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();

    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
    writeFileSync(join(root, 'scripts/value.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('observes production', () => assert.equal(value, 2));\n");
    writeFileSync(join(root, 'tests/e2e/value.e2e.spec.ts'), PLAYWRIGHT);
    writeFileSync(join(root, 'tests/e2e/collab/helper.ts'), 'export const helper = 1;\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'production + unit test + browser spec + its helper']);
    const oracle = join(ROOT, 'scripts/check-test-revert-oracle.mjs');
    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json']);
    assert.match(output, /set aside: tests\/e2e\/value\.e2e\.spec\.ts is a Playwright spec/);
    assert.match(output, /set aside: tests\/e2e\/collab\/helper\.ts is a root-owned support module/);
    assert.match(output, /OBSERVED/);
    assert.doesNotMatch(output, /no runner could be derived/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
