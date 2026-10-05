/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The browser observer's pure half (#6267): runner derivation from the root
 * package and Playwright JSON report -> oracle result. Every error message
 * below is captured verbatim from Playwright 1.63 (ANSI colouring included,
 * which the JSON reporter keeps even under NO_COLOR); refresh on a major bump.
 * The real-browser, whole-dispatcher cases are revert-oracle-browser-observer.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserRunArgs, browserRunner, isAssertionError, parsePlaywrightReport, scriptCommand } from './revert-oracle-browser.mjs';
import { buildExecutionLedger, ledgerVerdict } from './revert-oracle-ledger.mjs';
import { freePort } from './revert-oracle-browser-run.mjs';
import rootPackage from '../../package.json' with { type: 'json' };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = 'tests/e2e/target-size-focus-5826.e2e.spec.ts';

const MESSAGES = {
  customMessage: 'Error: button hit target is at least 24px\n\n\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBeGreaterThanOrEqual\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m\n\nExpected: >= \u001b[32m24\u001b[39m\nReceived:    \u001b[31m22\u001b[39m',
  plain: 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\nExpected: \u001b[32m2\u001b[39m\nReceived: \u001b[31m1\u001b[39m',
  visible: 'Error: btn\n\n\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoBeVisible\u001b[2m(\u001b[22m\u001b[2m)\u001b[22m failed\n',
  poll: 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBeGreaterThanOrEqual\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m\n\nExpected: >= \u001b[32m24\u001b[39m\nReceived:    \u001b[31m22\u001b[39m',
  waitForFunction: "TimeoutError: page.waitForFunction: Timeout 500ms exceeded.\n\n   5 | test('visible', async ({ page }) => { await expect(page.getByRole('button'), 'btn').toBeVisible({ timeout: 500 }); });",
  testTimeout: '\u001b[31mTest timeout of 8000ms exceeded.\u001b[39m',
  typeError: "TypeError: Cannot read properties of null (reading 'x')\n\n   7 | test('waitfn', async ({ page }) => { await page.waitForFunction(() => false, null, { timeout: 500 }); });",
  launch: "Error: browserType.launch: Chromium distribution 'chrome-canary' is not found at /opt/google/chrome-canary/chrome",
};

/** A Playwright JSON report for SPEC, shaped like the real reporter's (describe suite nesting included). */
function report(tests, errors = []) {
  return {
    config: { rootDir: join(ROOT, 'tests') },
    errors,
    suites: [{
      title: 'e2e/target-size-focus-5826.e2e.spec.ts', file: 'e2e/target-size-focus-5826.e2e.spec.ts', specs: [],
      suites: [{
        title: '#5826 target size and focus visibility', file: 'e2e/target-size-focus-5826.e2e.spec.ts',
        specs: tests.map(([title, status, messages = [], annotations = []]) => ({
          title, file: 'e2e/target-size-focus-5826.e2e.spec.ts',
          tests: [{
            projectName: 'viewer-e2e-ci', status, annotations,
            results: status === 'skipped' ? [{ status: 'skipped', errors: [] }] : [{ status: status === 'expected' ? 'passed' : 'failed', errors: messages.map((message) => ({ message })) }],
          }],
        })),
      }],
    }],
  };
}

const sameFile = (file) => resolve(ROOT, 'tests', file) === resolve(ROOT, SPEC);
const parse = (r, exitCode) => parsePlaywrightReport(r, { exitCode, signal: null, sameFile });
/** What runBrowserPlan attaches after parsing. */
const measured = (parsed, exitCode) => ({ ...parsed, rawExitCode: exitCode, signal: null, attributed: parsed.foreign === 0 && parsed.total > 0 });
const verdictOf = (baseline, reverted) => ledgerVerdict(buildExecutionLedger({
  plans: [{ file: SPEC, key: `playwright:${SPEC}`, browser: true, adapter: 'playwright', runner: { family: 'playwright', bin: 'playwright', args: ['test'] } }],
  baselineResults: [baseline], revertedResults: [reverted],
}));

const PASSING = [
  ['empty start screen: no visible button is under 24x24 CSS px', 'expected'],
  ['loaded model: no visible button is under 24x24 CSS px', 'expected'],
];
const GEOREF = 'authored model without georeferencing: Add Georeferencing target is at least 24x24 CSS px';

test('the runner is derived from the root scripts CI already runs', () => {
  const runner = browserRunner(rootPackage.scripts);
  assert.deepEqual(runner, {
    family: 'playwright', bin: 'playwright', args: ['test', '--project=viewer-e2e-ci'],
    build: { bin: 'turbo', args: ['build', '--filter=@ifc-lite/viewer'] },
  });
  assert.deepEqual(browserRunArgs(runner, SPEC, { globalTimeoutMs: 1000 }),
    ['test', '--project=viewer-e2e-ci', SPEC, '--reporter=list,json', '--retries=0', '--workers=1', '--global-timeout=1000']);
  assert.equal(browserRunner({ 'test:e2e:ci': 'vitest run' }), null, 'not a Playwright command');
  assert.equal(browserRunner({}), null, 'no CI browser script');
  assert.equal(browserRunner({ 'test:e2e:ci': 'playwright test', 'build:e2e': 'pnpm a && pnpm b' }), null, 'a build the oracle would have to reinterpret');
  assert.equal(scriptCommand('FOO=1 playwright test'), null);
  assert.equal(scriptCommand('playwright test "x y"'), null);
});

test('only Playwright matcher failures are assertions, with or without a custom message', () => {
  for (const key of ['customMessage', 'plain', 'visible', 'poll']) assert.equal(isAssertionError({ message: MESSAGES[key] }), true, key);
  for (const key of ['waitForFunction', 'testTimeout', 'typeError', 'launch']) assert.equal(isAssertionError({ message: MESSAGES[key] }), false, key);
});

test('#6254 regression: baseline passes, the reverted CSS fails the measured 24px target -> OBSERVED', () => {
  const baseline = parse(report([...PASSING, [GEOREF, 'expected']]), 0);
  assert.equal(baseline.kind, 'pass');
  const reverted = parse(report([...PASSING, [GEOREF, 'unexpected', [MESSAGES.poll]]]), 1);
  assert.equal(reverted.kind, 'assertion-failure');
  assert.deepEqual([reverted.passed, reverted.failed, reverted.total], [2, 1, 3]);
  assert.deepEqual(reverted.evidence, [
    `assertion failed: #5826 target size and focus visibility > ${GEOREF}: expect(received).toBeGreaterThanOrEqual(expected); Expected: >= 24; Received:    22`,
  ]);
  const verdict = verdictOf(measured(baseline, 0), measured(reverted, 1));
  assert.equal(verdict.verdict, 'OBSERVED');
  assert.equal(verdict.witness.file, SPEC);
});

test('a failure no assertion decided never becomes OBSERVED', () => {
  const baseline = measured(parse(report([...PASSING, [GEOREF, 'expected']]), 0), 0);
  for (const key of ['waitForFunction', 'testTimeout', 'typeError']) {
    const reverted = parse(report([...PASSING, [GEOREF, 'unexpected', [MESSAGES[key]]]]), 1);
    assert.equal(reverted.kind, 'unparseable', key);
    assert.match(reverted.evidence[0], /no failing test failed on an expect\(\) assertion/);
    assert.equal(verdictOf(baseline, measured(reverted, 1)).verdict, 'INCONCLUSIVE', key);
  }
  // A test timeout racing a pending expect.poll carries both errors: not an assertion verdict.
  const raced = parse(report([[GEOREF, 'unexpected', [MESSAGES.testTimeout, MESSAGES.poll]]]), 1);
  assert.equal(raced.kind, 'unparseable');
});

test('browser startup and runner failures are not observations', () => {
  const launch = parse(report([[GEOREF, 'unexpected', [MESSAGES.launch]]]), 1);
  assert.equal(launch.kind, 'runner-missing');
  const baseline = measured(parse(report([[GEOREF, 'expected']]), 0), 0);
  assert.equal(verdictOf(measured(launch, 1), measured(launch, 1)).verdict, 'BASELINE-BROKEN');
  assert.equal(verdictOf(baseline, measured(launch, 1)).verdict, 'INCONCLUSIVE');

  const webServer = parse(report([], [{ message: 'Error: Process from config.webServer was not able to start. Exit code: 1' }]), 1);
  assert.equal(webServer.kind, 'runner-missing');
  const syntax = parse(report([], [{ message: 'SyntaxError: /repo/tests/e2e/x.e2e.spec.ts: Missing semicolon. (1:6)' }]), 1);
  assert.equal(syntax.kind, 'load-failure');
  assert.equal(parse(null, 1).kind, 'unparseable', 'no report at all');
  assert.equal(parsePlaywrightReport(null, { exitCode: null, signal: 'SIGTERM', sameFile }).kind, 'unparseable');
});

test('skipped and zero-run specs never count as observation', () => {
  const skip = [GEOREF, 'skipped', [], [{ type: 'skip', description: 'tests/models/ara3d/AC20-FZK-Haus.ifc missing — run `pnpm fixtures`' }]];
  const allSkipped = parse(report([skip]), 0);
  assert.equal(allSkipped.kind, 'all-skipped');
  assert.match(allSkipped.evidence.join('\n'), /skipped: .*run `pnpm fixtures`/);
  assert.equal(verdictOf(measured(allSkipped, 0), measured(allSkipped, 0)).verdict, 'BASELINE-BROKEN');

  const none = parse(report([], [{ message: 'Error: No tests found.\nMake sure that arguments are regular expressions matching test files.' }]), 1);
  assert.equal(none.kind, 'no-tests');
  assert.equal(parse(report([]), 0).kind, 'no-tests');

  // A partial skip keeps real evidence, as for every other runner (#4108).
  const partial = parse(report([...PASSING, skip]), 0);
  assert.equal(partial.kind, 'pass');
});

test('pass/pass is UNOBSERVED only over the same executed collection', () => {
  const baseline = measured(parse(report([...PASSING, [GEOREF, 'expected']]), 0), 0);
  assert.equal(verdictOf(baseline, baseline).verdict, 'UNOBSERVED');
  const skippedAfterRevert = measured(parse(report([...PASSING, [GEOREF, 'skipped']]), 0), 0);
  assert.equal(verdictOf(baseline, skippedAfterRevert).verdict, 'INCONCLUSIVE', 'a test that stopped executing is not a pass');
});

test('a report that disagrees with the process, or runs another file, is not attributable', () => {
  assert.equal(parse(report([[GEOREF, 'expected']]), 1).kind, 'unparseable', 'green report, red exit');
  assert.equal(parse(report([[GEOREF, 'unexpected', [MESSAGES.poll]]]), 0).kind, 'unparseable', 'red report, green exit');
  const foreign = parsePlaywrightReport(report([[GEOREF, 'unexpected', [MESSAGES.poll]]]), { exitCode: 1, signal: null, sameFile: () => false });
  assert.equal(foreign.foreign, 1);
  const baseline = measured(parse(report([[GEOREF, 'expected']]), 0), 0);
  assert.notEqual(verdictOf(baseline, measured(foreign, 1)).verdict, 'OBSERVED');
});

test('the preview port is reserved even when FORCE_COLOR is set in the inherited environment', () => {
  // Some terminals export FORCE_COLOR=3. A child that prints the port with
  // console.log(<number>) then emits it wrapped in ANSI escapes, and the
  // reservation reads as "could not reserve a preview port".
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  try {
    const port = freePort();
    assert.equal(Number.isInteger(port) && port > 0 && port < 65536, true, `port: ${port}`);
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = saved;
  }
});
