/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure half of the revert oracle's Playwright observer (#6267): how a browser
 * run is derived from the root package, and how its JSON report becomes the
 * same `{ kind, passed, failed, total }` result every other runner produces.
 * The spawning half is `revert-oracle-browser-run.mjs`.
 *
 * WHY. A production change whose only witness is a Playwright spec (#6254: a
 * one-class CSS target-size fix, asserted by measuring the rendered button in
 * a real browser) was UNOBSERVED by construction, because the oracle had no
 * browser runner. A class-string node test would only mirror the source.
 *
 * WHAT COUNTS AS OBSERVATION. Only a test that RAN and failed on a Playwright
 * `expect(...)` matcher. A browser that never started, a webServer that never
 * came up, a navigation or `waitForFunction` timeout, a skipped test and a
 * spec that selected zero tests are all outcomes in which no browser
 * assertion was evaluated, so none of them may become OBSERVED -- the same
 * load-failure-is-not-a-RED rule the oracle applies to every runner.
 */

// revert-oracle.mjs first: it is the entry of the all-skipped import cycle.
import { hasLoadError } from './revert-oracle.mjs';
import { classifyExecuted } from './revert-oracle-all-skipped.mjs';
import { processResultGap } from './revert-oracle-process-result.mjs';

/** The root script CI's viewer-e2e lane runs, and the one it builds with. */
export const BROWSER_TEST_SCRIPT = 'test:e2e:ci';
export const BROWSER_BUILD_SCRIPT = 'build:e2e';

/**
 * A package.json script as a plain argv, or null when it uses shell syntax
 * this oracle will not reinterpret (pipes, `&&`, quoting, env assignments).
 */
export function scriptCommand(script) {
  if (typeof script !== 'string' || script.trim() === '') return null;
  if (/[|&;<>()$`'"\\*?]/.test(script)) return null;
  const [bin, ...args] = script.trim().split(/\s+/);
  if (/=/.test(bin)) return null;
  return { bin, args };
}

/**
 * Derive the browser runner from the root package's scripts: `test:e2e:ci`
 * must be a `playwright test ...` command; `build:e2e`, when present, is run
 * before every measurement so each side of the revert is served its own build.
 */
export function browserRunner(scripts) {
  const test = scriptCommand(scripts?.[BROWSER_TEST_SCRIPT]);
  if (!test || test.bin !== 'playwright' || test.args[0] !== 'test') return null;
  const buildScript = scripts?.[BROWSER_BUILD_SCRIPT];
  const build = buildScript === undefined ? null : scriptCommand(buildScript);
  if (buildScript !== undefined && !build) return null;
  return { family: 'playwright', bin: 'playwright', args: test.args, build };
}

/** The argv for one scoped measurement of `spec`. */
export function browserRunArgs(runner, spec, { list = false, globalTimeoutMs } = {}) {
  return [
    ...runner.args,
    spec,
    ...(list ? ['--list', '--reporter=json'] : ['--reporter=list,json', '--retries=0', '--workers=1']),
    ...(globalTimeoutMs ? [`--global-timeout=${globalTimeoutMs}`] : []),
  ];
}

/** Every test in a Playwright JSON report, with the file it came from. */
export function reportTests(report) {
  const out = [];
  const walk = (suite, titles) => {
    const path = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.push({ file: spec.file ?? suite.file, title: [...path, spec.title].join(' > '), project: t.projectName, test: t });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report?.suites ?? []) walk(suite, []);
  return out;
}

/**
 * Playwright's matcher errors: `expect(received).toEqual(expected)`,
 * `expect(locator).toBeVisible() failed`, `expect.poll` (which reports as
 * `expect(received)`). A custom message (`expect(x, 'why')`) is printed on the
 * first line and the matcher line follows it, so any line may carry it; the
 * source snippet Playwright appends is indented and never starts a line with
 * `expect(`. An error without that line (launch, navigation, waitForFunction,
 * a test timeout, a TypeError in the test body) means no assertion decided
 * the failure. Messages are captured verbatim from Playwright 1.63 in
 * revert-oracle-browser.test.mjs; refresh them on a major bump.
 */
const EXPECT_ERROR_RE = /^(?:Error: )?expect\((?:received|locator|page|value|apiResponse)\)\.(?:not\.)?\w+\(/m;

// Playwright's JSON reporter keeps the ANSI colouring of matcher messages.
// eslint-disable-next-line no-control-regex
const plain = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

export function isAssertionError(error) {
  return EXPECT_ERROR_RE.test(plain(error?.message));
}

const firstLine = (text) => plain(text).trim().split('\n')[0];

/** The matcher line plus Playwright's `Expected:` / `Received:` lines: the measured value is the evidence. */
function assertionSummary(message) {
  const lines = plain(message).split('\n').map((line) => line.trim());
  const matcher = lines.findIndex((line) => EXPECT_ERROR_RE.test(line));
  const detail = lines.slice(matcher + 1).filter((line) => /^(Expected|Received)\b/.test(line)).slice(0, 2);
  return [lines[matcher].replace(/^Error: /, ''), ...detail].join('; ');
}

/**
 * @param {object|null} report Playwright JSON report
 * @param {{ file: string, sameFile: (reportFile: string) => boolean, exitCode: number|null, signal: string|null }} run
 */
export function parsePlaywrightReport(report, run) {
  const empty = { passed: null, failed: null, total: null };
  if (!report || typeof report !== 'object') {
    const gap = processResultGap(empty, run);
    return gap ?? { kind: 'unparseable', ...empty, evidence: ['Playwright wrote no JSON report'] };
  }
  const globalErrors = (report.errors ?? []).map((error) => firstLine(error.message ?? error.value));
  const tests = reportTests(report);
  if (globalErrors.length > 0 && tests.every(({ test }) => test.status === 'skipped' || (test.results ?? []).length === 0)) {
    const text = (report.errors ?? []).map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`).join('\n');
    if (tests.length === 0 && /No tests found/.test(text)) {
      return { kind: 'no-tests', passed: 0, failed: 0, total: 0, evidence: ['Playwright: No tests found for this spec'] };
    }
    return {
      // A spec that fails to compile is a load failure; a webServer that never
      // started or a config that would not load is the runner being absent.
      kind: hasLoadError(text) ? 'load-failure' : 'runner-missing',
      ...empty,
      evidence: globalErrors.map((line) => `Playwright global error before any test ran: ${line}`),
    };
  }

  const foreign = tests.filter(({ file }) => !run.sameFile(file));
  const identities = [], evidence = [], nonAssertion = [];
  let passed = 0, failed = 0, assertions = 0;
  for (const { title, project, test } of tests) {
    const last = test.results?.at(-1);
    const ran = test.status !== 'skipped';
    identities.push(`${project} > ${title} [${ran ? 'ran' : 'skipped'}]`);
    if (!ran) {
      const why = (test.annotations ?? []).find((a) => a.type === 'skip')?.description;
      evidence.push(`skipped: ${title}${why ? ` (${why})` : ''}`);
      continue;
    }
    if (test.status === 'expected') { passed += 1; continue; }
    failed += 1;
    const errors = last?.errors?.length ? last.errors : last?.error ? [last.error] : [];
    if (test.status === 'unexpected' && errors.length > 0 && errors.every(isAssertionError)) {
      assertions += 1;
      evidence.push(`assertion failed: ${title}: ${assertionSummary(errors[0].message)}`);
    } else {
      nonAssertion.push(title);
      evidence.push(`failed WITHOUT an assertion (${test.status}/${last?.status ?? 'no result'}): ${title}: ${firstLine(errors[0]?.message) || 'no error recorded'}`);
    }
  }
  const counted = { passed, failed, total: tests.length, identities, evidence, foreign: foreign.length };
  if (tests.length === 0) return { kind: 'no-tests', passed: 0, failed: 0, total: 0, identities, evidence: ['Playwright selected zero tests for this spec'] };
  const gap = processResultGap(counted, run);
  if (gap) return { ...gap, identities, evidence: [...gap.evidence, ...evidence] };
  if (failed > 0 && assertions === 0) {
    const infra = /browserType\.launch|Executable doesn't exist|distribution '.*' is not found/.test(evidence.join('\n'));
    return { kind: infra ? 'runner-missing' : 'unparseable', ...counted, evidence: [`no failing test failed on an expect() assertion (${nonAssertion.length} non-assertion failure(s))`, ...evidence] };
  }
  const executed = classifyExecuted({ ...counted, evidence: [] });
  return { ...counted, ...executed, identities, evidence: [...executed.evidence, ...evidence] };
}
