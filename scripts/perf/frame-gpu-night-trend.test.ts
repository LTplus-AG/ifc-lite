/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendNightTrend, decodeNightTrend, nightTrendRow, type NightTrendRow } from './frame-gpu-night-trend.js';
import { admitThresholds, evaluateNight, regressionIssueAction, REGRESSION_ISSUE_TITLE, type NightThresholds } from './frame-gpu-night-alert.js';
import { sha256 } from './frame-gpu-night-profile.js';
import type { SampleRecord } from './frame-gpu-summary.js';

// Synthetic rig receipts only: these are never real nightly evidence.
const HEAD = 'c'.repeat(40);
const profileBytes = (host = 'test-only-host') => Buffer.from(JSON.stringify({
  version: 1, sourceHead: HEAD, rustTree: 'd'.repeat(40), dist: 'dist', fixture: 'fixture.ifc',
  qualificationReceipt: 'review.json', hostProfile: host, artifacts: [{ path: 'fixture.ifc', sha256: 'e'.repeat(64) }],
}));
const console0 = { currentSession: 1, consoleSession: 1, protocol: 0, connectState: 0, remoteMetric: 0, monitors: 1 };

function admittedSample(pair: number, rafP95: number, gpuTotal = 2): SampleRecord {
  const rows = ['orbit', 'hover'].flatMap((scenario) => [
    { fixture: 'FZK', scenario, metric: 'raf_delta_ms_p95', value: rafP95 },
    { fixture: 'FZK', scenario, metric: 'gpu_pass_total_ms_p50', value: gpuTotal },
  ]);
  const timing = { mode: 'gpu-queries', errors: 0 };
  return { pair, side: 'branch', ok: true, rows, meta: {
    hostBefore: { quiet: true }, hostAfter: { quiet: true }, sessionBefore: console0, sessionAfter: console0,
    foreground: { interruptions: 0, visibility: 'visible', focused: true }, adapter: { vendor: 'nvidia', architecture: 'blackwell' },
    gpuTiming: { orbit: timing, hover: timing },
  } };
}

const jsonl = (samples: SampleRecord[]) => Buffer.from(samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
const at = (day: number, hour = 1) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

function night(day: number, samples: SampleRecord[], profile = profileBytes()): NightTrendRow {
  return nightTrendRow({ runsJsonl: jsonl(samples), sourceRevisions: { branch: HEAD, base: null }, profile,
    startedAt: at(day, 1), finishedAt: at(day, 2), appendedAt: at(day, 3) });
}

function trendOf(rows: NightTrendRow[]): NightTrendRow[] {
  return decodeNightTrend(rows.reduce((text, row) => appendNightTrend(text, row), ''));
}

const sevenNights = () => trendOf(Array.from({ length: 7 }, (_, i) => night(i + 1, [admittedSample(0, 9 + i), admittedSample(1, 10 + i)])));
const thresholdsFor = (trend: NightTrendRow[], maxima: Record<string, number>): NightThresholds => ({
  version: 1, profileSha256: trend[0].profileSha256, calibrationReceipts: trend.slice(0, 7).map((row) => row.receiptSha256), maxima,
});

test('#6975 an admitted rig run becomes one ok night with per-metric medians bound to its raw receipt', () => {
  const samples = [admittedSample(0, 10), admittedSample(1, 12), admittedSample(2, 20)];
  const row = night(5, samples);
  assert.equal(row.status, 'ok');
  assert.equal(row.night, '2026-10-05');
  assert.equal(row.receiptSha256, sha256(jsonl(samples)));
  assert.equal(row.profileSha256, sha256(profileBytes()));
  assert.deepEqual(row.samples, { ok: 3, total: 3 });
  assert.equal(row.metrics['FZK/orbit/raf_delta_ms_p95'], 12);
  assert.equal(row.metrics['FZK/hover/gpu_pass_total_ms_p50'], 2);
});

test('#6975 a run without strict admission witnesses is retained as failed, never admitted', () => {
  const unflagged = admittedSample(0, 10);
  delete unflagged.meta!.hostBefore;
  const software = admittedSample(1, 10);
  software.meta!.adapter = { vendor: 'google', architecture: 'swiftshader' };
  const noTiming = admittedSample(2, 10);
  noTiming.meta!.gpuTiming = { orbit: { mode: 'disabled', errors: 0 }, hover: { mode: 'disabled', errors: 0 } };
  noTiming.rows = noTiming.rows.filter((row) => !row.metric.startsWith('gpu_pass_'));
  const remote = admittedSample(3, 10);
  remote.meta!.sessionAfter = { ...console0, protocol: 2 };
  for (const sample of [unflagged, software, noTiming, remote]) {
    const row = night(5, [admittedSample(9, 10), sample]);
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.metrics, {});
    assert.ok(row.reasons.length > 0 && row.reasons.every((reason) => reason.startsWith(`pair ${sample.pair}:`)), row.reasons.join('; '));
  }
});

test('#6975 an admission refusal is a refused night that keeps its reason', () => {
  const row = night(5, [{ pair: 0, side: 'branch', ok: false, error: 'host pre-admission refused', rows: [] }]);
  assert.equal(row.status, 'refused');
  assert.deepEqual(row.reasons, ['pair 0: host pre-admission refused']);
});

test('#6975 base/branch runs, foreign source revisions and late appends cannot become a night', () => {
  const base = { ...admittedSample(0, 10), side: 'base' as const };
  assert.throws(() => night(5, [base]), /one build/);
  const input = { runsJsonl: jsonl([admittedSample(0, 10)]), profile: profileBytes(), startedAt: at(5, 1), finishedAt: at(5, 2) };
  assert.throws(() => nightTrendRow({ ...input, sourceRevisions: { branch: 'f'.repeat(40), base: null }, appendedAt: at(5, 3) }), /does not match/);
  assert.throws(() => nightTrendRow({ ...input, sourceRevisions: { branch: HEAD, base: 'f'.repeat(40) }, appendedAt: at(5, 3) }), /one build/);
  assert.throws(() => nightTrendRow({ ...input, sourceRevisions: { branch: HEAD, base: null }, appendedAt: at(6, 3) }), /backfill/);
});

test('#6975 the trend is append-only: replayed receipts and earlier runs are refused', () => {
  const first = night(5, [admittedSample(0, 10)]);
  const text = appendNightTrend('', first);
  assert.throws(() => appendNightTrend(text, first), /already in the trend/);
  assert.throws(() => appendNightTrend(text, night(4, [admittedSample(0, 11)])), /append-only/);
  const refused = night(6, [{ pair: 0, side: 'branch', ok: false, error: 'physical-console admission refused', rows: [] }]);
  assert.deepEqual(decodeNightTrend(appendNightTrend(text, refused)).map((row) => row.status), ['ok', 'refused']);
});

test('#6975 without a thresholds file every night is uncalibrated and nothing alerts', () => {
  const trend = sevenNights();
  const verdict = evaluateNight(trend, '2026-10-07', null);
  assert.deepEqual(verdict, { state: 'uncalibrated', night: '2026-10-07', calendar: { nights: 7, ready: true, reason: 'seven consecutive raw nightly artifacts available for admission and threshold review' } });
  assert.equal(regressionIssueAction(verdict, null), null);
});

test('#6975 thresholds are admitted only against seven consecutive measured nights they do not undercut', () => {
  const trend = sevenNights();
  const key = 'FZK/orbit/raf_delta_ms_p95';
  assert.doesNotThrow(() => admitThresholds(trend, thresholdsFor(trend, { [key]: 16.5 })));
  assert.throws(() => admitThresholds(trend, thresholdsFor(trend, { [key]: 14.5 })), /below calibration night 2026-10-07 \(15\)/);
  assert.throws(() => admitThresholds(trend, thresholdsFor(trend, { 'FZK/orbit/not_measured': 1 })), /did not measure/);
  assert.throws(() => admitThresholds(trend, { ...thresholdsFor(trend, { [key]: 20 }), calibrationReceipts: trend.slice(0, 6).map((row) => row.receiptSha256) }), /exactly seven/);
  assert.throws(() => admitThresholds(trend, { ...thresholdsFor(trend, { [key]: 20 }), profileSha256: 'f'.repeat(64) }), /different profile/);
  const gap = trendOf([...Array.from({ length: 3 }, (_, i) => night(i + 1, [admittedSample(0, 9 + i / 10)])), ...Array.from({ length: 4 }, (_, i) => night(i + 5, [admittedSample(0, 10 + i / 10)]))]);
  assert.throws(() => admitThresholds(gap, thresholdsFor(gap, { [key]: 20 })), /missing scheduled night/);
  const changed = trendOf(Array.from({ length: 7 }, (_, i) => night(i + 1, [admittedSample(0, 9 + i / 10)], profileBytes(i === 3 ? 'other-host' : 'test-only-host'))));
  assert.throws(() => admitThresholds(changed, thresholdsFor(changed, { [key]: 20 })), /profile changed/);
});

test('#6975 a calibrated night over its maximum is a regression that opens, then updates, one issue', () => {
  const key = 'FZK/orbit/raf_delta_ms_p95';
  const trend = trendOf([...sevenNights(), night(8, [admittedSample(0, 30)]), night(9, [admittedSample(0, 16)]),
    night(10, [{ pair: 0, side: 'branch', ok: false, error: 'host pre-admission refused', rows: [] }])]);
  const thresholds = admitThresholds(trend, thresholdsFor(trend, { [key]: 16.5, 'FZK/hover/gpu_pass_total_ms_p50': 2 }));
  const regression = evaluateNight(trend, '2026-10-08', thresholds);
  assert.equal(regression.state, 'regression');
  assert.deepEqual(regression.state === 'regression' && regression.breaches, [{ metric: key, value: 30, max: 16.5 }]);
  const created = regressionIssueAction(regression, null);
  assert.equal(created?.action, 'create');
  assert.equal(created?.action === 'create' && created.title, REGRESSION_ISSUE_TITLE);
  assert.match(created!.body, /\| `FZK\/orbit\/raf_delta_ms_p95` \| 30 \| 16\.5 \|/);
  assert.deepEqual(regressionIssueAction(regression, 42), { action: 'comment', issue: 42, body: created!.body });
  assert.equal(evaluateNight(trend, '2026-10-09', thresholds).state, 'ok');
  assert.equal(evaluateNight(trend, '2026-10-10', thresholds).state, 'refused');
  assert.equal(evaluateNight(trend, '2026-10-11', thresholds).state, 'missing');
  for (const quiet of ['2026-10-09', '2026-10-10', '2026-10-11']) assert.equal(regressionIssueAction(evaluateNight(trend, quiet, thresholds), 42), null);
});

test('#6975 CLI appends a real rig directory and reports a regression through gh', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), '6975-night-trend-'));
  try {
    const trendPath = join(dir, 'trend.jsonl'), log = join(dir, 'gh.log'), bin = join(dir, 'bin');
    mkdirSync(bin);
    // Fake gh: records argv, lists issue 77 as open only when GH_OPEN is set.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$1 $2 $3" >> "${log}"\nif [ "$2" = list ]; then if [ -n "$GH_OPEN" ]; then echo '[{"number":77,"title":"${REGRESSION_ISSUE_TITLE}"}]'; else echo '[]'; fi; fi\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(dir, 'profile.json'), profileBytes());
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.NODE_TEST_CONTEXT;
    const cli = (...args: string[]) => spawnSync(`${root}/node_modules/.bin/tsx`, ['scripts/perf/frame-gpu-night-trend.mts', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    // Seven earlier nights through the pure API (an append CLI only takes a fresh run),
    // then the actual CLI appends tonight's real run directory and refuses a stale one.
    const startedMs = Date.now() - 600_000;
    const tonight = new Date(startedMs).toISOString().slice(0, 10);
    const dayMs = (offset: number, hour: number) => Date.parse(`${tonight}T00:00:00Z`) + offset * 86_400_000 + hour * 3_600_000;
    const seeds: NightTrendRow[] = [];
    for (let i = 7; i >= 1; i--) {
      seeds.push(nightTrendRow({ runsJsonl: jsonl([admittedSample(0, 10 + i)]), sourceRevisions: { branch: HEAD, base: null },
        profile: profileBytes(), startedAt: new Date(dayMs(-i, 0)).toISOString(), finishedAt: new Date(dayMs(-i, 0) + 60_000).toISOString(),
        appendedAt: new Date(dayMs(-i, 0) + 120_000).toISOString() }));
    }
    writeFileSync(trendPath, seeds.reduce((text, seed) => appendNightTrend(text, seed), ''));
    const rigRun = (name: string, rafP95: number, startSec: number) => {
      const run = join(dir, name);
      mkdirSync(run);
      writeFileSync(join(run, 'source-revisions.json'), JSON.stringify({ branch: HEAD, base: null }));
      writeFileSync(join(run, 'runs.jsonl'), jsonl([admittedSample(0, rafP95)]));
      writeFileSync(join(run, 'summary.json'), '{}');
      utimesSync(join(run, 'source-revisions.json'), startSec, startSec);
      utimesSync(join(run, 'summary.json'), startSec + 60, startSec + 60);
      return run;
    };
    const stale = cli('append', '--trend', trendPath, '--run', rigRun('stale', 10, startedMs / 1000 - 3 * 86_400), '--profile', join(dir, 'profile.json'));
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /backfill is refused/);
    const fresh = cli('append', '--trend', trendPath, '--run', rigRun('fresh', 40, startedMs / 1000), '--profile', join(dir, 'profile.json'));
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout), { night: tonight, status: 'ok', receiptSha256: sha256(jsonl([admittedSample(0, 40)])), reasons: [] });
    const appendedRows = decodeNightTrend(readFileSync(trendPath, 'utf8'));
    assert.equal(appendedRows.length, 8);
    assert.equal(appendedRows[7].night, tonight);
    assert.equal(appendedRows[7].status, 'ok');
    const thresholdsPath = join(dir, 'thresholds.json');
    writeFileSync(thresholdsPath, JSON.stringify(thresholdsFor(seeds, { 'FZK/orbit/raf_delta_ms_p95': 17 })));
    const uncalibrated = cli('evaluate', '--trend', trendPath, '--night', tonight, '--report-issue');
    assert.equal(uncalibrated.status, 0, uncalibrated.stderr);
    assert.equal(JSON.parse(uncalibrated.stdout.split('\n')[0]).state, 'uncalibrated');
    const created = cli('evaluate', '--trend', trendPath, '--night', tonight, '--thresholds', thresholdsPath, '--report-issue');
    assert.equal(created.status, 1, created.stderr);
    env.GH_OPEN = '1';
    assert.equal(cli('evaluate', '--trend', trendPath, '--night', tonight, '--thresholds', thresholdsPath, '--report-issue').status, 1);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['issue list --state', 'issue list --state', 'issue create --title', 'issue list --state', 'issue comment 77']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
