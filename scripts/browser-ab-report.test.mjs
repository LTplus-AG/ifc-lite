/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/browser-ab-report.mjs (#3978), EXECUTED against real
 * `runs.jsonl` input and a real exit code — not a hand-crafted fixture kept
 * only on a reviewer's machine.
 *
 * The regression this guards: when every sample on one side of a fixture
 * failed, the per-fixture loop already noticed ("no comparable samples on
 * one side") but nothing outside that loop iteration remembered it, so
 * execution fell through to the same calm `VERDICT: no metric moved beyond
 * the machine noise floor` a fully successful run gets, and exited 0 — a
 * false all-clear with zero actual comparisons. The fix tracks this in
 * `anyIncomparableFixture`, gives it its own VERDICT line, and exits
 * nonzero. This test proves the reporter still refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'perf', 'browser-ab-report.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'browser-ab-report-'));
let seq = 0;

const METRICS = {
  firstBatchWaitMs: 100,
  firstVisibleGeometryMs: 150,
  streamCompleteMs: 400,
  spatialReadyMs: 450,
  metadataCompleteMs: 500,
  totalWallClockMs: 600,
  metadataRenderReadyMs: 600,
};

function sample({ side, fixture, round, ok = true, totalMeshes = 1000, jitter = 0 }) {
  const row = { side, fixture, round, ok, totalMeshes };
  if (!ok) {
    row.error = 'launched-then-crashed';
    return row;
  }
  for (const [key, value] of Object.entries(METRICS)) row[key] = value + jitter;
  return row;
}

/**
 * Run the reporter exactly as the perf harness invokes it. Deliberately
 * omits `--json`: this test pins the reporter's human-readable stdout and
 * exit code, which is the actual CI-facing surface (the harness prints
 * this text into the job log), not the machine-readable report file.
 */
function run(rows) {
  const n = (seq += 1);
  const jsonlPath = join(TMP, `runs-${n}.jsonl`);
  writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [SCRIPT, jsonlPath, '--base', 'A', '--branch', 'B'], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('THE REGRESSION: both base samples failed, branch is healthy — not the calm verdict, nonzero exit', () => {
  const r = run([
    sample({ side: 'A', fixture: 'large-arch', round: 1, ok: false }),
    sample({ side: 'A', fixture: 'large-arch', round: 2, ok: false }),
    sample({ side: 'B', fixture: 'large-arch', round: 1 }),
    sample({ side: 'B', fixture: 'large-arch', round: 2 }),
  ]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /no comparable samples on one side/);
  assert.match(r.out, /VERDICT: .*inconclusive.*NOT a clean "no regression" result/);
  assert.doesNotMatch(
    r.out,
    /VERDICT: no metric moved beyond the machine noise floor/,
    'zero comparisons happened for this fixture; the calm within-noise verdict must not print',
  );
});

test('THE HEALTHY CONTROL: two samples per side, no drift — ordinary verdict, exit 0', () => {
  const r = run([
    sample({ side: 'A', fixture: 'large-arch', round: 1 }),
    sample({ side: 'A', fixture: 'large-arch', round: 2 }),
    sample({ side: 'B', fixture: 'large-arch', round: 1 }),
    sample({ side: 'B', fixture: 'large-arch', round: 2 }),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VERDICT: no metric moved beyond the machine noise floor — within noise; totalMeshes matched across all rounds\./);
});

test('totalMeshes mismatch between sides: invalidates the timing comparison (#3978)', () => {
  // A changed-output comparison must not return a successful timing verdict.
  const r = run([
    sample({ side: 'A', fixture: 'large-arch', round: 1, totalMeshes: 500 }),
    sample({ side: 'A', fixture: 'large-arch', round: 2, totalMeshes: 500 }),
    sample({ side: 'B', fixture: 'large-arch', round: 1, totalMeshes: 600 }),
    sample({ side: 'B', fixture: 'large-arch', round: 2, totalMeshes: 600 }),
  ]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /OUTPUT CHANGED: totalMeshes 500→600/);
  assert.match(r.out, /VERDICT: .*totalMeshes fingerprint changed/);
});

test('a real regression on one fixture and a crashed-on-one-side second fixture: BOTH verdict lines print, not just the calmer one', () => {
  // Regression this guards: anyRealChange and anyIncomparableFixture are
  // exclusive branches of the same if/else-if before this fix, so a real
  // regression detected on one fixture silently swallowed the warning that
  // a DIFFERENT fixture was never actually measured — the process still
  // exited nonzero (anyIncomparableFixture is unconditional in the exit
  // expression), but the only VERDICT line printed read like a clean,
  // trustworthy "a metric moved" result with no textual explanation for
  // the nonzero exit.
  const r = run([
    sample({ side: 'A', fixture: 'regressed', round: 1 }),
    sample({ side: 'A', fixture: 'regressed', round: 2 }),
    sample({ side: 'B', fixture: 'regressed', round: 1, jitter: 500 }),
    sample({ side: 'B', fixture: 'regressed', round: 2, jitter: 500 }),
    sample({ side: 'A', fixture: 'crashed', round: 1, ok: false }),
    sample({ side: 'A', fixture: 'crashed', round: 2, ok: false }),
    sample({ side: 'B', fixture: 'crashed', round: 1 }),
    sample({ side: 'B', fixture: 'crashed', round: 2 }),
  ]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /VERDICT: a metric moved beyond the noise floor/);
  assert.match(r.out, /VERDICT: .*inconclusive.*NOT a clean "no regression" result/);
});

test('#3978 refuses legacy or contradictory readiness without rewriting the app total', () => {
  for (const readiness of [undefined, 200]) {
    const a = sample({ side: 'A', fixture: 'late-metadata', round: 1 });
    const b = sample({ side: 'B', fixture: 'late-metadata', round: 1 });
    a.totalWallClockMs = b.totalWallClockMs = 200;
    a.metadataCompleteMs = b.metadataCompleteMs = 265;
    a.metadataRenderReadyMs = b.metadataRenderReadyMs = readiness;
    const { code, out } = run([a, b]);
    assert.equal(code, 1, out);
    assert.match(out, /missing\/inconsistent observed/);
    assert.doesNotMatch(out, /VERDICT: no metric moved/);
  }
});

test('#3978 mesh drift never reports matching fingerprints or within-noise success', () => {
  const { code, out } = run([
    sample({ side: 'A', fixture: 'drift', round: 1, totalMeshes: 500 }),
    sample({ side: 'B', fixture: 'drift', round: 1, totalMeshes: 600 }),
  ]);
  assert.equal(code, 1, out);
  assert.match(out, /fingerprint changed/);
  assert.doesNotMatch(out, /totalMeshes matched|VERDICT: no metric moved/);
});
