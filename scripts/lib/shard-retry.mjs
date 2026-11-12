/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure half of `scripts/ci-shard-retry.mjs`: the mode, which failures a
 * retry may cover, and whether a retry passed. No process, no filesystem.
 *
 * Every function here answers "retry" or "passed" only on positive evidence.
 * A report it cannot read, a failure it cannot tie to a file or test id, a
 * retry that ran nothing: each is a NO, which leaves the job red.
 */

import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['off', 'shadow', 'on'];

/**
 * More failures than this in one shard is a real break, not a flake, and is
 * not retried. Measured flakes in the queue fail one file or one spec.
 */
export const MAX_RETRY_FILES = 5;
export const MAX_RETRY_TESTS = 5;

/**
 * The switch. Lowercased because Actions' `==` is case-insensitive and
 * test.yml compares `vars.CI_SHARD_RETRY == 'on'` directly; NOT trimmed, for
 * the same reason (Actions does not trim either). Anything else is `off`.
 */
export function decideMode(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === '') return { mode: 'off' };
  if (MODES.includes(v)) return { mode: v };
  return { mode: 'off', warning: `CI_SHARD_RETRY=${JSON.stringify(String(raw))} is not one of ${MODES.join(', ')}; no retry` };
}

const OK = /^( *)ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/;
const SUBTEST = /^( *)# Subtest: (.*)$/;
const NOT_OK = /^( *)not ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/;
const YAML_FIELD = /^ *(location|failureType|type|error): '((?:[^']|'')*)'$/;
/** node's message for a test cancelled because its parent ended first (e.g. a failed hook). */
const PARENT_CANCELLED = 'test did not finish before its parent and was cancelled';
const SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/;

function unescapeTitle(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/**
 * The failures and the closing counts of a node:test TAP stream. The counts
 * are taken only from the block that ENDS the stream (through
 * `# duration_ms`): a test's own stdout reaches TAP as `# ...` lines, so a
 * test printing `tests 9` must not pass for the run's summary.
 *
 * Every result carries its `path`: the titles of the subtests that enclose
 * it and its own, joined with ` › `, so two tests with one title in
 * different suites stay apart.
 *
 * @param {string} text
 * @returns {{ failures: { title: string, path: string, depth: number, location: string|null, failureType: string|null, type: string|null }[],
 *             passed: Set<string>, summary: Record<string, number>|null }}
 * `passed` holds the paths of TESTS that passed: skips, todos and suites
 * (TAP `type: 'suite'`) excluded.
 */
export function parseNodeTap(text) {
  const failures = [];
  const oks = [];
  const counts = {};
  const stack = [];
  let open = null;
  // Inside a result's `---` ... `...` YAML block: an error message there may
  // itself contain TAP text, which must not count as results.
  let inYaml = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const s = SUMMARY.exec(line);
    // Anything after a run of count lines means they were not the closing block.
    if (!s && line.trim() !== '') for (const k of Object.keys(counts)) delete counts[k];
    if (inYaml) {
      if (/^ *\.\.\.$/.test(line)) {
        inYaml = false;
        open = null;
        continue;
      }
      const f = open && YAML_FIELD.exec(line);
      if (f) open[f[1]] = f[2].replace(/''/g, "'");
      continue;
    }
    if (open && /^ *---$/.test(line)) {
      inYaml = true;
      continue;
    }
    const sub = SUBTEST.exec(line);
    if (sub) {
      const depth = sub[1].length / 4;
      stack.length = depth;
      stack[depth] = unescapeTitle(sub[2]);
    }
    const pathOf = (indent, title) => [...stack.slice(0, indent.length / 4), unescapeTitle(title)].join(' › ');
    const ok = OK.exec(line);
    if (ok) {
      open = { path: pathOf(ok[1], ok[2]), type: null, skipped: Boolean(ok[3]) };
      oks.push(open);
      continue;
    }
    const m = NOT_OK.exec(line);
    if (m) {
      // A TODO result is not a failure, but its YAML block is skipped the same way.
      if (m[3] === 'TODO') {
        open = { todo: true };
        continue;
      }
      open = { title: unescapeTitle(m[2]), path: pathOf(m[1], m[2]), depth: m[1].length / 4, location: null, failureType: null, type: null };
      failures.push(open);
      continue;
    }
    if (s) {
      counts[s[1]] = Number(s[2]);
      open = null;
    }
  }
  const summary = ['tests', 'pass', 'fail', 'cancelled', 'duration_ms'].every((k) => k in counts) ? counts : null;
  const passed = new Set(oks.filter((o) => !o.skipped && o.type !== 'suite').map((o) => o.path));
  return { failures, passed, summary };
}

/** A viewer test path; no segment may start with `.`, so `..` cannot escape `src/`. */
const VIEWER_TEST_FILE = /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.tsx?$/;

function locationFile(location, root) {
  const path = location.replace(/:\d+:\d+$/, '');
  const abs = path.startsWith('file://') ? fileURLToPath(path) : path;
  if (!isAbsolute(abs)) return null;
  const rel = relative(root, abs).split('\\').join('/');
  return VIEWER_TEST_FILE.test(rel) ? rel : null;
}

/**
 * Tie each TAP failure to a viewer test file (relative to `root`,
 * `apps/viewer`): by its `location:` when it has one, else, for a top-level
 * failure, by its title, which node sets to the file path when the FILE
 * failed (a crash on import, a non-zero exit, a timeout). Node reports
 * locations by real path, so `root` must be a real path too.
 *
 * @returns {{ files: string[], tests: { file: string, title: string }[], unattributed: string[] }}
 */
export function attributeViewerFailures(failures, root) {
  const files = new Set();
  const tests = [];
  const unattributed = [];
  for (const f of failures) {
    let file = f.location ? locationFile(f.location, root) : null;
    if (!file && f.depth === 0 && VIEWER_TEST_FILE.test(f.title)) file = f.title;
    if (!file) {
      unattributed.push(f.title);
      continue;
    }
    files.add(file);
    // A suite is re-checked through its tests (cancelled ones included),
    // never as a test of its own: a suite is never a passing result.
    if (f.failureType !== 'subtestsFailed' && f.type !== 'suite') {
      // didNotRun shapes only the report; the retry still has to pass the
      // test. node also uses cancelledByParent for a test left pending when
      // its file's loop drained, which ran, hence the message check.
      tests.push({ file, title: f.title, path: f.path, didNotRun: f.failureType === 'cancelledByParent' && f.error === PARENT_CANCELLED });
    }
  }
  return { files: [...files].sort(), tests, unattributed };
}

/**
 * Refuse a retry when the first attempt's TAP is not a COMPLETE record of the
 * shard. node prints the closing `# tests`/`# fail` counts only when every
 * file it was given has finished; a runner killed mid-shard leaves the `not
 * ok` lines it had already printed and no counts (reproduced with SIGTERM,
 * SIGINT and SIGKILL), and retrying those files would pass a shard whose
 * other files never ran. node counts every failed or cancelled TEST, a
 * `test()` whose subtest failed included, but not a `describe` suite (TAP
 * `type: 'suite'`, e.g. one whose `before` hook threw), so the non-suite
 * failures listed must equal `fail + cancelled` (all shapes reproduced).
 *
 * @returns {string|null} the refusal, or null when the record is complete
 */
export function incompleteViewerAttempt({ failures, summary }) {
  if (!summary) return "the first attempt's TAP has no closing summary, so the runner did not finish the shard";
  const listed = failures.filter((f) => f.type !== 'suite').length;
  const counted = summary.fail + summary.cancelled;
  if (listed !== counted) return `the first attempt lists ${listed} failure(s) but its summary counts ${counted}`;
  return null;
}

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/**
 * An awk ERE matching exactly these paths, for apps/viewer's `TEST_PATTERN`.
 * `.` becomes `[.]` rather than `\.` because `awk -v` expands backslash
 * escapes before the regex sees them. A path with any other punctuation is
 * refused rather than escaped.
 */
export function viewerPattern(files) {
  if (files.length === 0) throw new Error('no files to retry');
  for (const f of files) if (!SAFE_PATH.test(f)) throw new Error(`refusing to build a pattern for ${JSON.stringify(f)}`);
  return `^(${files.map((f) => f.replace(/\./g, '[.]')).join('|')})$`;
}

/**
 * Whether to retry. `count` is files (viewer) or test ids (e2e).
 *
 * @param {{ mode: string, count: number, cap: number, unattributed?: string[], refusal?: string }} input
 * @returns {{ retry: boolean, reason: string }}
 */
export function planRetry({ mode, count, cap, unattributed = [], refusal }) {
  if (mode !== 'shadow' && mode !== 'on') return { retry: false, reason: 'CI_SHARD_RETRY is off' };
  if (refusal) return { retry: false, reason: refusal };
  if (unattributed.length > 0) {
    return { retry: false, reason: `${unattributed.length} failure(s) could not be tied to a test: ${unattributed.slice(0, 5).map((t) => JSON.stringify(t)).join(', ')}` };
  }
  if (count === 0) return { retry: false, reason: 'the first attempt failed but its report names no failing test' };
  if (count > cap) return { retry: false, reason: `${count} failed; more than ${cap} is treated as a real failure, not a flake` };
  return { retry: true, reason: `retrying ${count}` };
}

/**
 * A viewer retry of ONE file passed: exit 0, a complete TAP summary, at least
 * one pass, nothing failed or cancelled, and every test of that file that
 * failed on the first attempt (`tests`) passed again under the same path: a
 * skip, a todo or a suite is not a pass. A file-level failure (its title is
 * the file's path) has no test to match; the file must load and pass, which
 * the counts cover. One file per retry run, so a same-titled test in another
 * file cannot stand in.
 */
export function judgeViewerRetry({ exitCode, summary, passed = new Set(), tests = [] }) {
  if (exitCode !== 0) return { passed: false, reason: `the retry exited ${exitCode ?? 'by signal or timeout'}` };
  if (!summary) return { passed: false, reason: 'the retry produced no complete TAP summary' };
  if (summary.fail !== 0 || summary.cancelled !== 0) return { passed: false, reason: `the retry reported ${summary.fail} failed, ${summary.cancelled} cancelled` };
  if (!(summary.pass >= 1)) return { passed: false, reason: 'the retry ran no passing test' };
  const missing = tests.filter((t) => t.title !== t.file && !passed.has(t.path));
  if (missing.length > 0) return { passed: false, reason: `${missing.length} test(s) that failed did not pass on retry: ${missing.map((t) => t.title).join('; ')}` };
  return { passed: true, reason: `the retry passed (${summary.pass} passed)` };
}

/**
 * Playwright's `.last-run.json` from the first attempt. Only a `failed` run is
 * retried: `interrupted` and `timedout` mean the 13-minute cap or a hang, and
 * a hang does not fit in what is left of the job.
 */
export function readLastRun(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ids: [], refusal: 'the first attempt left no readable .last-run.json' };
  }
  const ids = Array.isArray(data?.failedTests) ? data.failedTests : null;
  if (!ids || ids.some((x) => typeof x !== 'string')) return { ids: [], refusal: '.last-run.json has no failedTests list' };
  if (data.status !== 'failed') return { ids, refusal: `the first attempt ended \`${data.status}\`; only \`failed\` is retried` };
  return { ids: [...new Set(ids)] };
}

/**
 * Every test in a Playwright JSON report, by test id.
 * @returns {Map<string, { title: string, file: string, line: number, status: string, expectedStatus: string, annotations: string[] }>}
 */
export function indexPlaywrightReport(report) {
  const out = new Map();
  const walk = (suite, path) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.set(spec.id, {
          title: [...here.slice(1), spec.title].join(' › '),
          file: spec.file,
          line: spec.line,
          status: t.status,
          expectedStatus: t.expectedStatus,
          annotations: (t.annotations ?? []).map((a) => a.type),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of report?.suites ?? []) walk(s, []);
  return out;
}

/**
 * How many retried ids count towards the cap: a test the first attempt
 * skipped because an earlier one failed (a beforeAll, a serial group) is
 * rerun and judged, but one flaky hook should not read as a mass failure.
 */
export function retryCount(ids, index) {
  return ids.filter((id) => index?.get(id)?.status !== 'skipped').length;
}

/** A deliberate skip: `test.skip` or `test.fixme`, at declaration or at runtime. */
const askedToSkip = (t) => t.expectedStatus === 'skipped' && t.annotations.some((a) => a === 'skip' || a === 'fixme');

/**
 * Tests the first attempt skipped WITHOUT asking to: a failing `beforeAll` or
 * an earlier failure in a serial group skips the rest, and those tests keep
 * `expectedStatus: 'passed'` and carry no `skip`/`fixme` annotation. A
 * deliberate skip (`test.skip`, `test.fixme`, at declaration or at runtime)
 * has `expectedStatus: 'skipped'` and the annotation. Both shapes reproduced
 * on the locked Playwright 1.64.1.
 */
export function unintendedSkips(index) {
  const out = [];
  for (const [id, t] of index) {
    if (t.status !== 'skipped') continue;
    if (!askedToSkip(t)) out.push(id);
  }
  return out;
}

/**
 * Refuse an E2E retry unless the first attempt's JSON report is readable,
 * records no run-level error (its top-level `errors`: global setup or
 * teardown, outside any test, which a retry of tests cannot clear), knows
 * every failed id, and lists every test it skipped without asking among the
 * ids being retried. Playwright 1.64.1 already lists such tests in
 * `.last-run.json` (`didNotRun`); this holds the retry to that independently
 * of the version.
 *
 * @returns {string|null}
 */
export function incompleteE2eAttempt({ ids, index, errors = [] }) {
  if (!index) return "the first attempt's JSON report is missing or unreadable";
  if (errors.length > 0) return `the first attempt recorded ${errors.length} error(s) outside any test`;
  const unknown = ids.filter((id) => !index.has(id));
  if (unknown.length > 0) return `${unknown.length} failed test id(s) are not in the first attempt's report`;
  const retried = new Set(ids);
  const unlisted = unintendedSkips(index).filter((id) => !retried.has(id));
  if (unlisted.length > 0) return `${unlisted.length} test(s) the first attempt skipped without asking are not in its failed list`;
  return null;
}

/**
 * An e2e retry passed: exit 0, and every retried id ran again with outcome
 * `expected`, which for anything but a `test.fail()` test means it passed. A
 * skip, deliberate or not, is `skipped` and does not count.
 */
export function judgeE2eRetry({ exitCode, ids, report, first = new Map() }) {
  if (exitCode !== 0) return { passed: false, reason: `the retry exited ${exitCode ?? 'by signal or timeout'}` };
  if (!report) return { passed: false, reason: 'the retry left no readable JSON report' };
  const index = indexPlaywrightReport(report);
  const missing = ids.filter((id) => !index.has(id));
  if (missing.length > 0) return { passed: false, reason: `the retry did not run ${missing.length} of the ${ids.length} failed test(s)` };
  // A test the first attempt never ran (an earlier failure skipped it) may
  // skip on retry when it asks to; anything else must pass.
  const bad = ids.filter((id) => {
    const t = index.get(id);
    if (t.status === 'expected') return false;
    return !(first.get(id)?.status === 'skipped' && t.status === 'skipped' && askedToSkip(t));
  });
  if (bad.length > 0) return { passed: false, reason: `${bad.length} test(s) did not pass on retry: ${bad.map((id) => index.get(id).title).join('; ')}` };
  return { passed: true, reason: `all ${ids.length} retried test(s) passed` };
}

/** A title on one line, for a table cell or an annotation. */
export function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ');
}

/**
 * The job-summary section for one shard.
 * @param {{ kind: string, shard: string, mode: string, plan: { retry: boolean, reason: string },
 *           tests: { file: string, title: string }[], result?: { passed: boolean, reason: string },
 *           passed: boolean }} r  `passed`: the retry ran and passed
 */
export function summaryLines(r) {
  const { passed } = r;
  const lines = [`## Shard retry (\`CI_SHARD_RETRY=${r.mode}\`): ${r.kind} shard ${r.shard}`, ''];
  if (!r.plan.retry) {
    lines.push(`The first attempt failed. Not retried: ${r.plan.reason}.`);
  } else {
    lines.push(`The first attempt failed. Retried once: **${passed ? 'passed' : 'failed'}** (${r.result?.reason ?? 'no result'}).`);
  }
  if (r.tests.length > 0) {
    lines.push('', '| Failed on the first attempt | File |', '| --- | --- |');
    for (const t of r.tests) lines.push(`| ${oneLine(t.title).replace(/\|/g, '\\|')}${t.didNotRun ? ' (did not run: an earlier failure skipped it)' : ''} | \`${t.file}\` |`);
  }
  lines.push('');
  if (r.mode === 'on') {
    lines.push(passed
      ? 'The job passes on the retry. The tests above are flaky: fix them, a retry only hides the cost.'
      : 'The job fails.');
  } else {
    lines.push(`Shadow mode: the job keeps the first attempt's verdict (failure). With \`on\` it would have ${passed ? 'passed' : 'failed'}.`);
  }
  return lines;
}
