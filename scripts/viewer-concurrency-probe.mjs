#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The steps of .github/workflows/viewer-concurrency-probe.yml (why it exists
 * and when it runs is in that file's header). ADVISORY: both modes exit 0.
 * `--report` puts a test failure at concurrency 2, or fewer files REPORTING a
 * result than the 16-shard gate selects, in the summary and a warning
 * annotation; a red check here would read as a red main.
 *
 *   node scripts/viewer-concurrency-probe.mjs --shard
 *     TEST_SHARDS, TEST_SHARD, VIEWER_TEST_CONCURRENCY, JOB_STARTED_AT (epoch
 *     seconds, the job's first step), OUT (record path). Runs apps/viewer's
 *     own `test` script and records the files that reported a result
 *     (scripts/lib/test-file-reporter.mjs), wall time and failures.
 *   node scripts/viewer-concurrency-probe.mjs --report
 *     RECORDS (dir of shard records), EXPECTED_SHARDS. Writes the summary.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from './lib/is-main-entry.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = join(REPO_ROOT, 'apps/viewer');
const FILE_REPORTER = join(REPO_ROOT, 'scripts/lib/test-file-reporter.mjs');
/**
 * apps/viewer's `test` script cut at `marker`, then printing `$<variable>`.
 * The probe runs the script's own parts rather than copying them: the
 * concurrency bound (`$c`, set before ` files=`) and the file selection
 * (`$files`, set before ` && tsx `).
 */
export function cutCommand(testScript, marker, variable) {
  const at = testScript.indexOf(marker);
  if (at <= 0) throw new Error(`apps/viewer's test script no longer has \`${marker.trim()}\` to cut at`);
  const glue = marker.trim().startsWith('&&') ? ' &&' : '';
  return `${testScript.slice(0, at)}${glue} printf '%s\\n' "$${variable}"`;
}

export function viewerTestScript() {
  return JSON.parse(readFileSync(join(VIEWER, 'package.json'), 'utf8')).scripts.test;
}

function runCut(env, marker, variable) {
  const r = spawnSync('sh', ['-c', cutCommand(viewerTestScript(), marker, variable)], { cwd: VIEWER, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`apps/viewer's test script failed before \`${marker.trim()}\`: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

/** The files apps/viewer's script selects under `env`. */
export function selectFiles(env) {
  return runCut(env, ' && tsx ', 'files');
}

/** The `--test-concurrency` apps/viewer's script uses under `env`; no file selection runs. */
export function scriptConcurrency(env) {
  return runCut(env, ' files=', 'c')[0];
}

/**
 * The files test-file-reporter.mjs saw report, relative to apps/viewer.
 * Output that is not a JSON array of paths throws, so the caller reports why.
 */
export function reportedFiles(text, viewerRoot) {
  const abs = JSON.parse(text);
  if (!Array.isArray(abs) || abs.some((f) => typeof f !== 'string')) throw new Error('file list is not a JSON array of paths');
  return abs.map((f) => relative(viewerRoot, f).split('\\').join('/'));
}

/**
 * Read the reporter's output. A missing file is the expected "runner did not
 * finish" case; anything else, and unparseable output, is logged by name.
 * Either way the shard counts no files, which the report shows as a shortfall.
 */
function readReportedFiles(path, viewerRoot) {
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') console.log(`::warning title=Viewer concurrency probe::no file list at ${path}: the test runner did not finish`);
    else console.log(`::warning title=Viewer concurrency probe::could not read the file list ${path}: ${err.message}`);
    return [];
  }
  try {
    return reportedFiles(text, viewerRoot);
  } catch (err) {
    console.log(`::warning title=Viewer concurrency probe::unreadable file list ${path}: ${err.message}`);
    return [];
  }
}

/**
 * The shard records in `dir`. No directory means the download matched no
 * artifact (every shard failed before uploading): no records, which the
 * report names as missing shards. Any other read error propagates.
 */
export function readRecords(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.log(`::warning title=Viewer concurrency probe::no shard records at ${dir}`);
    return [];
  }
  const records = [];
  for (const f of names.filter((n) => n.endsWith('.json'))) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch (err) {
      // A garbled record counts as a missing shard; the rest still report.
      console.log(`::warning title=Viewer concurrency probe (advisory)::unreadable shard record ${f}: ${err.message}`);
    }
  }
  return records;
}

const SUMMARY = /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/;
const TOP_FAIL = /^not ok \d+ - (.*)$/;

/** Closing counts and top-level failure titles of a node:test TAP stream. */
export function parseTap(text) {
  const counts = {};
  const failures = [];
  for (const line of String(text).split('\n')) {
    const s = SUMMARY.exec(line);
    if (s) counts[s[1]] = Number(s[2]);
    const f = TOP_FAIL.exec(line);
    if (f && !/ # TODO\b/.test(line)) failures.push(f[1]);
  }
  return { counts: 'tests' in counts ? counts : null, failures };
}

function shard(env) {
  // Read before the run: a failure here must not discard a finished shard.
  const concurrency = scriptConcurrency(env);
  const started = Date.now();
  const tapFile = `${env.OUT}.tap`;
  const filesFile = `${env.OUT}.files`;
  const r = spawnSync('pnpm', ['--filter', '@ifc-lite/viewer', 'run', 'test'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...env,
      NODE_OPTIONS: `--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=${tapFile} --test-reporter=${FILE_REPORTER} --test-reporter-destination=${filesFile}`,
    },
  });
  const ended = Date.now();
  let tap = '';
  try {
    tap = readFileSync(tapFile, 'utf8');
  } catch (err) {
    console.log(`::warning title=Viewer concurrency probe::no TAP file (${err.message})`);
  }
  const { counts, failures } = parseTap(tap);
  const reported = readReportedFiles(filesFile, realpathSync(VIEWER));
  const jobStarted = Number(env.JOB_STARTED_AT) * 1000;
  return {
    shard: Number(env.TEST_SHARD),
    concurrency,
    reported,
    testStepSeconds: (ended - started) / 1000,
    jobStartedAt: Number.isFinite(jobStarted) && jobStarted > 0 ? jobStarted : started,
    endedAt: ended,
    exitCode: r.status,
    counts,
    failures,
  };
}

/**
 * The probe's verdict on its own completeness.
 *
 * `allFiles` is what the gate runs: its 16 shards partition the full
 * selection exactly, each file once (scripts/viewer-test-shards.test.mjs),
 * so the gate's file count is `allFiles.length`.
 *
 * @param {object[]} records  one per probe shard
 * @param {string[]} allFiles every viewer test file (selection with no shard)
 * @param {number} expectedShards
 */
export function report(records, allFiles, expectedShards) {
  // What REPORTED a result, not what was selected: a runner that dies early
  // selected every file and reported few.
  const ran = records.flatMap((r) => r.reported ?? []);
  const ranSet = new Set(ran);
  const missingShards = [];
  for (let s = 0; s < expectedShards; s++) if (!records.some((r) => r.shard === s)) missingShards.push(s);
  const notRun = allFiles.filter((f) => !ranSet.has(f));
  const all = new Set(allFiles);
  const extra = [...ranSet].filter((f) => !all.has(f));
  const duplicates = ran.length - ranSet.size;
  const start = Math.min(...records.map((r) => r.jobStartedAt));
  const end = Math.max(...records.map((r) => r.endedAt));
  const jobMinutes = records.reduce((a, r) => a + (r.endedAt - r.jobStartedAt) / 60_000, 0);
  const failed = records.filter((r) => r.exitCode !== 0 || !r.counts || r.counts.fail > 0 || r.counts.cancelled > 0);
  const testStepMinutes = records.reduce((a, r) => a + r.testStepSeconds / 60, 0);
  const complete = missingShards.length === 0 && notRun.length === 0 && duplicates === 0 && extra.length === 0;
  const conc = [...new Set(records.map((r) => r.concurrency))].join(', ') || '?';
  const lines = [
    `## Viewer tests at concurrency ${conc} over ${expectedShards} shards (advisory)`,
    '',
    '| | |',
    '| --- | --- |',
    `| Wall time (first job step to last shard end) | ${records.length ? ((end - start) / 60_000).toFixed(1) : '?'} min |`,
    `| Job-minutes (sum over shards, from each job's first step) | ${jobMinutes.toFixed(1)} |`,
    `| Slowest test step | ${records.length ? (Math.max(...records.map((r) => r.testStepSeconds)) / 60).toFixed(1) : '?'} min |`,
    `| Test-step minutes, summed (independent of shard balance) | ${testStepMinutes.toFixed(1)} |`,
    `| Test files that reported a result | ${ranSet.size} |`,
    `| Test files the 16-shard gate executes | ${allFiles.length} |`,
    `| Tests passed / failed / cancelled | ${sum(records, 'pass')} / ${sum(records, 'fail')} / ${sum(records, 'cancelled')} |`,
    '',
    complete
      ? `File coverage matches the gate exactly (${ran.length} files, each once).`
      : `⚠️ File coverage does NOT match the gate: ${missingShards.length} shard record(s) missing (${missingShards.join(', ') || 'none'}), ${notRun.length} file(s) reported no result${notRun.length ? ` (first: ${notRun.slice(0, 5).map((f) => `\`${f}\``).join(', ')})` : ''}, ${duplicates} reported twice, ${extra.length} reported that the gate does not run.`,
    '',
    // The duration manifest is packed for 16 shards, so 8 shards take the
    // path-hash split, measured at 336-900 s per shard where LPT gives ~654 s.
    `Shard balance: ${expectedShards} shards use the path-hash split, not the gate's duration packing, so wall time and the slowest step include shard imbalance and this runner type. Compare the summed test-step minutes with the gate's.`,
  ];
  if (failed.length > 0) {
    lines.push('', `⚠️ ${failed.length} shard(s) failed at this concurrency:`);
    for (const r of failed) lines.push(`- shard ${r.shard}: exit ${r.exitCode}${r.failures.length ? `, ${r.failures.slice(0, 10).map((t) => `\`${t}\``).join(', ')}` : ''}`);
  } else if (records.length > 0) {
    lines.push('', 'No test failed at this concurrency.');
  }
  return { complete, failed: failed.length, lines };
}

function sum(records, key) {
  return records.reduce((a, r) => a + (r.counts?.[key] ?? 0), 0);
}

export function run(argv, env = process.env) {
  if (argv[0] === '--shard') {
    const record = shard(env);
    writeFileSync(env.OUT, `${JSON.stringify(record)}\n`);
    console.log(`[viewer-concurrency-probe] shard ${record.shard}/${env.TEST_SHARDS} at concurrency ${record.concurrency}: ${record.reported.length} files reported, ${record.testStepSeconds.toFixed(0)} s, exit ${record.exitCode}`);
    return 0;
  }
  if (argv[0] === '--report') {
    const records = readRecords(env.RECORDS);
    const allFiles = selectFiles({ ...env, TEST_SHARDS: '', TEST_SHARD: '', TEST_PATTERN: '' });
    const out = report(records, allFiles, Number(env.EXPECTED_SHARDS));
    for (const l of out.lines) console.log(l);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${out.lines.join('\n')}\n`);
    if (!out.complete || out.failed > 0) {
      console.log('::warning title=Viewer concurrency probe (advisory)::coverage short of the gate or a test failed; see the job summary');
    }
    return 0;
  }
  throw new Error('one of --shard or --report is required');
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    // Advisory: a crash is a warning, never a red check on main.
    console.log(`::warning title=Viewer concurrency probe (advisory)::${err.message}`);
  }
}
