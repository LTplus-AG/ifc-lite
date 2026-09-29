/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The revert oracle's browser observer end to end (#6267): the unmodified
 * dispatcher, a real `playwright test` and a real Chrome, against synthetic
 * repositories shaped like #6254 -- a production-only CSS target-size change
 * whose one witness measures the rendered button in the browser.
 *
 * The synthetic root mirrors the real one's contract: `build:e2e` builds the
 * served asset (so each side of the revert is served its own build) and
 * `test:e2e:ci` is `playwright test --project=<ci project>`. The real-viewer
 * replay of #6254 itself is in the PR evidence; its captured Playwright report
 * is pinned in revert-oracle-browser.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const oracle = join(repo, 'scripts/check-test-revert-oracle.mjs');

// Sized like the viewer's compact button: 12px text, 16px line, 2px padding.
const CSS_BEFORE = '.add { font: 12px/16px sans-serif; padding: 2px 6px; border: 1px solid teal; }\n';
const CSS_AFTER = '.add { font: 12px/16px sans-serif; padding: 2px 6px; border: 1px solid teal; min-height: 24px; }\n';

const measuringSpec = (selector, { skip = false } = {}) => `import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('Add Georeferencing target is at least 24x24 CSS px', async ({ page }) => {
  ${skip ? "test.skip(true, 'fixture missing — run `pnpm fixtures`');" : ''}
  const css = readFileSync('dist/target.css', 'utf8');
  await page.setContent(\`<style>\${css}</style><button class="add">Add Georeferencing</button><button class="other" style="min-height:24px;min-width:24px">x</button>\`);
  const target = page.locator('${selector}');
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return Math.min(rect.width, rect.height);
  }), { timeout: 2000 }).toBeGreaterThanOrEqual(24);
});
`;

function resultPayload(output) {
  const start = output.indexOf('\n{');
  assert.notEqual(start, -1, `oracle emitted no JSON result:\n${output}`);
  return JSON.parse(output.slice(start + 1));
}

function repoWith({ spec, specName = 'target.e2e.spec.mjs', nodeWitness = false }) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-browser-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Revert oracle fixture']);
  run('git', ['config', 'user.email', 'oracle@example.invalid']);
  run('git', ['config', 'core.autocrlf', 'false']);
  for (const dir of ['src', 'tests/e2e', 'scripts']) mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\ntest-results\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'turbo test', 'build:e2e': 'node build.mjs', 'test:e2e:ci': 'playwright test --project=probe-ci' },
  }));
  writeFileSync(join(root, 'build.mjs'), "import { cpSync, mkdirSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncpSync('src/target.css', 'dist/target.css');\n");
  writeFileSync(join(root, 'playwright.config.mjs'), `export default {
  testDir: './tests', timeout: 30000,
  projects: [{ name: 'probe-ci', testMatch: /\\.e2e\\.spec\\.mjs$/, use: { headless: true, channel: 'chrome' } }],
};\n`);
  writeFileSync(join(root, 'src/target.css'), CSS_BEFORE);
  writeFileSync(join(root, 'src/min-height.mjs'), "export const minHeight = (css) => /min-height:\\s*24px/.test(css);\n");
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'base: pre-fix CSS']);
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(root, 'src/target.css'), CSS_AFTER);
  writeFileSync(join(root, 'tests/e2e', specName), spec);
  if (nodeWitness) {
    writeFileSync(join(root, 'scripts/min-height.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { minHeight } from '../src/min-height.mjs';\ntest('css carries the 24px floor', () => assert.equal(minHeight(readFileSync('src/target.css', 'utf8')), true));\n");
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'head: 24px target and its witness']);
  const oracleRun = (expected) => resultPayload(run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], expected));
  return { root, run, oracleRun, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const browserEntry = (payload) => payload.ledger.find((entry) => entry.file.startsWith('tests/e2e/'));

test('#6254 shape: reverting a production-only CSS target size fails the measured 24px browser assertion -> OBSERVED', { timeout: 240_000 }, () => {
  const fixture = repoWith({ spec: measuringSpec('.add') });
  try {
    const payload = fixture.oracleRun(0);
    assert.equal(payload.verdict, 'OBSERVED', payload.reason);
    assert.equal(payload.restoration, 'verified');
    const entry = browserEntry(payload);
    assert.equal(entry.adapter, 'playwright');
    assert.equal(entry.attribution, 'playwright-report-file');
    assert.equal(entry.baseline.kind, 'pass');
    assert.equal(entry.reverted.kind, 'assertion-failure');
    assert.match(entry.reverted.evidence.join('\n'), /assertion failed: Add Georeferencing target is at least 24x24 CSS px: expect\(received\)\.toBeGreaterThanOrEqual\(expected\); Expected: >= 24; Received: +\d/);
    assert.equal(fixture.run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    fixture.cleanup();
  }
});

test('a Playwright spec that does not touch the changed behavior passes on both sides -> UNOBSERVED', { timeout: 240_000 }, () => {
  const fixture = repoWith({ spec: measuringSpec('.other') });
  try {
    const payload = fixture.oracleRun(1);
    assert.equal(payload.verdict, 'UNOBSERVED', payload.reason);
    const entry = browserEntry(payload);
    assert.equal(entry.baseline.kind, 'pass');
    assert.equal(entry.reverted.kind, 'pass');
    assert.equal(payload.restoration, 'verified');
  } finally {
    fixture.cleanup();
  }
});

test('a Playwright spec whose only test skips (missing fixture) never counts as observation', { timeout: 240_000 }, () => {
  const fixture = repoWith({ spec: measuringSpec('.add', { skip: true }) });
  try {
    const payload = fixture.oracleRun(3);
    assert.notEqual(payload.verdict, 'OBSERVED');
    assert.equal(payload.verdict, 'BASELINE-BROKEN', payload.reason);
    assert.equal(browserEntry(payload).baseline.kind, 'all-skipped');
    assert.match(browserEntry(payload).baseline.evidence.join('\n'), /skipped: .*run `pnpm fixtures`/);
  } finally {
    fixture.cleanup();
  }
});

test('a Playwright spec the CI project does not select runs zero tests: a capability gap, not OBSERVED', { timeout: 240_000 }, () => {
  const fixture = repoWith({ spec: measuringSpec('.add'), specName: 'target.manual.spec.mjs' });
  try {
    const payload = fixture.oracleRun(3);
    assert.equal(payload.verdict, 'INCONCLUSIVE', payload.reason);
    const gap = payload.ledger.find((entry) => entry.role === 'capability-gap');
    assert.match(gap.reason, /selects no test in this spec/);
  } finally {
    fixture.cleanup();
  }
});

test('the browser observer runs only when needed: a node witness that already observes defers the spec and builds nothing', { timeout: 240_000 }, () => {
  const fixture = repoWith({ spec: measuringSpec('.add'), nodeWitness: true });
  try {
    const payload = fixture.oracleRun(0);
    assert.equal(payload.verdict, 'OBSERVED', payload.reason);
    assert.equal(payload.ledger.find((entry) => entry.role === 'deferred')?.file, 'tests/e2e/target.e2e.spec.mjs');
    assert.equal(existsSync(join(fixture.root, 'dist')), false, 'no browser build ran');
  } finally {
    fixture.cleanup();
  }
});
