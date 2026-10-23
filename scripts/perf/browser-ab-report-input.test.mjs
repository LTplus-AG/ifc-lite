/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Synthetic JSONL through the actual browser reporter; no browser/model run (#7912).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./browser-ab-report.mjs', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'browser-report-input-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
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

function run(rows) {
  const input = join(TMP, `rows-${++seq}.jsonl`);
  writeFileSync(input, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const child = spawnSync(process.execPath, [SCRIPT, input, '--base', 'A', '--branch', 'B'], { encoding: 'utf8' });
  return { code: child.status, out: `${child.stdout}${child.stderr}` };
}

function measuredRows() {
  return Array.from({ length: 5 }, (_, i) => ['A', 'B'].map(side =>
    sample({ side, fixture: 'zero-baseline', round: i + 1 }))).flat();
}

function runWithReport(rows) {
  const n = ++seq;
  const input = join(TMP, `measured-${n}.jsonl`);
  const output = join(TMP, `measured-${n}.json`);
  writeFileSync(input, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const child = spawnSync(process.execPath, [SCRIPT, input, '--base', 'A', '--branch', 'B', '--json', output],
    { encoding: 'utf8' });
  return { status: child.status, text: `${child.stdout}${child.stderr}`,
    data: JSON.parse(readFileSync(output, 'utf8')) };
}

test('#7912 browser zero baselines remain inconclusive or blocked for every comparable metric', () => {
  for (const field of Object.keys(METRICS).filter(key => key !== 'metadataRenderReadyMs')) {
    for (const branch of [0, 10]) {
      const rows = measuredRows();
      for (const row of rows) row[field] = row.side === 'A' ? 0 : branch;
      const comparison = runWithReport(rows);
      assert.equal(comparison.status, 0, comparison.text);
      const metric = comparison.data.fixtures[0].metrics.find(row => row.baseMedianMs === 0);
      assert.ok(metric, field);
      assert.equal(metric.branchMedianMs, branch);
      assert.equal(metric.deltaPct, null);
      assert.equal(metric.noisePct, null);
      assert.equal(metric.real, false);
      assert.equal(metric.direction, null);
      assert.equal(comparison.data.verdict.inconclusive, branch === 0);
      assert.equal(comparison.data.verdict.zeroBaselineIncrease, branch > 0);
      assert.doesNotMatch(comparison.text, /within noise/);
      // @source-text-assertion-ok actual reporter stdout; the only file read is its generated JSON report
      assert.match(comparison.text, branch === 0 ? /VERDICT:.*inconclusive/ : /VERDICT:.*blocked/);
    }
  }
});

test('#7912 browser positive-to-zero retains a finite faster direction', () => {
  const rows = measuredRows();
  for (const row of rows) if (row.side === 'B') row.firstVisibleGeometryMs = 0;
  const comparison = runWithReport(rows);
  assert.equal(comparison.status, 0, comparison.text);
  const metric = comparison.data.fixtures[0].metrics.find(row => row.metric === 'first-visible (actual paint)');
  assert.equal(metric.deltaPct, -100);
  assert.equal(metric.real, true);
  assert.equal(metric.direction, 'faster');
  assert.equal(comparison.data.verdict.inconclusive, false);
  assert.equal(comparison.data.verdict.zeroBaselineIncrease, false);
});

test('#7912 missing browser metric rounds cannot disappear into within-noise success', () => {
  for (const field of ['firstBatchWaitMs', 'spatialReadyMs']) {
    for (const missingAll of [false, true]) {
      const rows = [...measuredRows(), sample({ side: 'A', fixture: 'zero-baseline', round: 6 }),
        sample({ side: 'B', fixture: 'zero-baseline', round: 6 })];
      for (const row of rows) {
        row[field] = row.side === 'B' && (missingAll || row.round === 1) ? null : 0;
      }
      const comparison = runWithReport(rows);
      assert.equal(comparison.status, 0, comparison.text);
      assert.equal(comparison.data.verdict.insufficientPairedSamples, true);
      assert.doesNotMatch(comparison.text, /within noise/);
    }
  }
});

test('#7912 invalid browser identity and count fields cannot produce a timing verdict', () => {
  for (const overrides of [{ side: 'unknown' }, { fixture: '' }, { round: -1 }, { round: 1.5 },
    { totalMeshes: undefined }, { totalMeshes: -1 }, { totalMeshes: true }]) {
    const rows = measuredRows();
    Object.assign(rows[0], overrides);
    const result = run(rows);
    assert.equal(result.code, 2, result.out);
    assert.doesNotMatch(result.out, /VERDICT:/);
  }
});

test('#7912 invalid supplied browser timings are not silently filtered', () => {
  for (const field of Object.keys(METRICS)) {
    for (const value of [-1, 'invalid', true]) {
      const rows = measuredRows();
      rows[0][field] = value;
      const comparison = runWithReport(rows);
      assert.equal(comparison.status, 1, comparison.text);
      assert.equal(comparison.data.verdict.incomparableFixture, true);
      assert.doesNotMatch(comparison.text, /within noise/);
    }
  }
});

