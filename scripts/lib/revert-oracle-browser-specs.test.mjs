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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
