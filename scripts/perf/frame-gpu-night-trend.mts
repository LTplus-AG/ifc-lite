#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-GPU nightly trend and alert (#6975). Installs no scheduler and ships
 * no threshold; whatever runs the night calls it after the frame rig.
 *
 *   npx tsx scripts/perf/frame-gpu-night-trend.mts append \
 *     --trend <trend.jsonl> --run <rig --out-dir> --profile <night profile.json>
 *   npx tsx scripts/perf/frame-gpu-night-trend.mts evaluate \
 *     --trend <trend.jsonl> --night <YYYY-MM-DD> [--thresholds <file>] [--report-issue [--repo owner/name]]
 *
 * `append` reads the run's raw runs.jsonl, source-revisions.json and
 * summary.json; the run interval is those files' modification times.
 * `evaluate` prints the verdict as JSON and exits 1 only on a regression.
 * With --report-issue it opens the regression issue, or comments on the open
 * one, through `gh`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendNightTrend, decodeNightTrend, nightTrendRow } from './frame-gpu-night-trend.js';
import { admitThresholds, evaluateNight, regressionIssueAction, REGRESSION_ISSUE_TITLE } from './frame-gpu-night-alert.js';

const [command, ...argv] = process.argv.slice(2);
const flag = (name: string): string | null => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
const required = (name: string): string => flag(name) ?? fail(`${name} is required`);
function fail(message: string): never { console.error(`frame-gpu-night-trend: ${message}`); process.exit(2); }

function gh(args: string[]): string {
  const repo = flag('--repo');
  const run = spawnSync('gh', [...args, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) fail(`gh ${args[0]} ${args[1]} failed: ${run.error?.message ?? run.stderr}`);
  return run.stdout;
}

const trendPath = resolve(required('--trend'));
const trendText = existsSync(trendPath) ? readFileSync(trendPath, 'utf8') : '';

try {
  if (command === 'append') {
    const run = resolve(required('--run'));
    const runs = join(run, 'runs.jsonl'), revisions = join(run, 'source-revisions.json'), summary = join(run, 'summary.json');
    for (const path of [runs, revisions, summary]) if (!existsSync(path)) fail(`incomplete rig run, missing ${path}`);
    const row = nightTrendRow({
      runsJsonl: readFileSync(runs), sourceRevisions: JSON.parse(readFileSync(revisions, 'utf8')) as unknown,
      profile: readFileSync(resolve(required('--profile'))),
      startedAt: statSync(revisions).mtime.toISOString(), finishedAt: statSync(summary).mtime.toISOString(),
      appendedAt: new Date().toISOString(),
    });
    const next = appendNightTrend(trendText, row);
    writeFileSync(`${trendPath}.tmp`, next);
    renameSync(`${trendPath}.tmp`, trendPath);
    console.log(JSON.stringify({ night: row.night, status: row.status, receiptSha256: row.receiptSha256, reasons: row.reasons }));
  } else if (command === 'evaluate') {
    const trend = decodeNightTrend(trendText);
    const thresholdsPath = flag('--thresholds');
    const thresholds = thresholdsPath ? admitThresholds(trend, JSON.parse(readFileSync(resolve(thresholdsPath), 'utf8')) as unknown) : null;
    const verdict = evaluateNight(trend, required('--night'), thresholds);
    console.log(JSON.stringify(verdict));
    if (argv.includes('--report-issue')) {
      const open = (JSON.parse(gh(['issue', 'list', '--state', 'open', '--search', `"${REGRESSION_ISSUE_TITLE}" in:title`, '--json', 'number,title'])) as { number: number; title: string }[])
        .find((issue) => issue.title === REGRESSION_ISSUE_TITLE);
      const action = regressionIssueAction(verdict, open?.number ?? null);
      if (action?.action === 'create') gh(['issue', 'create', '--title', action.title, '--body', action.body]);
      if (action?.action === 'comment') gh(['issue', 'comment', String(action.issue), '--body', action.body]);
      if (action) console.log(JSON.stringify({ issue: action.action === 'comment' ? action.issue : 'created' }));
    }
    process.exit(verdict.state === 'regression' ? 1 : 0);
  } else {
    fail('usage: frame-gpu-night-trend.mts append|evaluate (see header)');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
