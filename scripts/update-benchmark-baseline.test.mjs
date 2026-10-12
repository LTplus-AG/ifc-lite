#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6993: a benchmark sample that lost its GPU device (`gpuHealth.contaminated`)
 * must never become the committed reference. The updater derives its root
 * from its own location, so a copy into a temp tree is the whole reproduction.
 *
 * Run: node --test scripts/update-benchmark-baseline.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLD = { timestamp: '2026-01-01', environment: 'github-actions', metrics: { totalWallClockMs: 100 } };

function tree(results) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-baseline-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const uploadHelper = join(HERE, 'lib', 'benchmark-upload-mode.mjs');
  if (existsSync(uploadHelper)) {
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    copyFileSync(uploadHelper, join(dir, 'scripts', 'lib', 'benchmark-upload-mode.mjs'));
  }
  mkdirSync(join(dir, 'tests', 'benchmark', 'benchmark-results'), { recursive: true });
  copyFileSync(join(HERE, 'update-benchmark-baseline.mjs'), join(dir, 'scripts', 'update-benchmark-baseline.mjs'));
  writeFileSync(join(dir, 'tests', 'benchmark', 'baseline.json'), JSON.stringify({ 'x.ifc': OLD, 'y.ifc': OLD }));
  for (const [i, result] of results.entries()) {
    writeFileSync(join(dir, 'tests', 'benchmark', 'benchmark-results', `viewer-${i}.json`), JSON.stringify(result));
  }
  return dir;
}

function run(dir) {
  const res = spawnSync(process.execPath, [join(dir, 'scripts', 'update-benchmark-baseline.mjs')], { encoding: 'utf-8', cwd: dir });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const baselineOf = (dir) => JSON.parse(readFileSync(join(dir, 'tests', 'benchmark', 'baseline.json'), 'utf-8'));

const lost = { contaminated: true, reasons: ['GPU device lost 1x'] };

test('#6993 count-only GPU results cannot overwrite the timing baseline', () => {
  const dir = tree([{ file: 'x.ifc', metrics: { totalWallClockMs: 1 }, environment: { uploadMode: 'count' } }]);
  try {
    const before = readFileSync(join(dir, 'tests', 'benchmark', 'baseline.json'));
    const { code, out } = run(dir);
    assert.equal(code, 1, out);
    assert.match(out, /not a timing workload/);
    assert.deepEqual(readFileSync(join(dir, 'tests', 'benchmark', 'baseline.json')), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const legacyMode of ['count', 'unknown', null]) {
  test(`#6993 a timed environment tag cannot admit legacy upload mode ${legacyMode} into the baseline`, () => {
    const dir = tree([{ file: 'x.ifc', metrics: { totalWallClockMs: 1 },
      environment: { uploadMode: 'timed' }, loadCounters: { uploadMode: legacyMode } }]);
    try {
      const before = readFileSync(join(dir, 'tests', 'benchmark', 'baseline.json'));
      const { code, out } = run(dir);
      assert.equal(code, 1, out);
      assert.match(out, /not a timing workload/);
      assert.deepEqual(readFileSync(join(dir, 'tests', 'benchmark', 'baseline.json')), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('#6993 matching timed environment and legacy tags can update the timing baseline', () => {
  const dir = tree([{ file: 'x.ifc', metrics: { totalWallClockMs: 1 },
    environment: { uploadMode: 'timed' }, loadCounters: { uploadMode: 'timed' } }]);
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.equal(baselineOf(dir)['x.ifc'].metrics.totalWallClockMs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#6993 a GPU-lost sample keeps the previous baseline entry; a clean one replaces it', () => {
  const dir = tree([
    { file: 'x.ifc', timestamp: '2026-10-10', metrics: { totalWallClockMs: 900 }, gpuHealth: lost },
    { file: 'y.ifc', timestamp: '2026-10-10', metrics: { totalWallClockMs: 120 }, gpuHealth: { contaminated: false, reasons: [] } },
  ]);
  try {
    const { code, out } = run(dir);
    const baseline = baselineOf(dir);
    assert.equal(code, 0, out);
    assert.deepEqual(baseline['x.ifc'], OLD, 'the device-lost sample must not overwrite the reference');
    assert.equal(baseline['y.ifc'].metrics.totalWallClockMs, 120);
    assert.match(out, /x\.ifc \(GPU device lost 1x\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#6993 when every sample lost its GPU device all previous entries are kept and the run still succeeds', () => {
  // A record_baseline dispatch on a runner whose software GPU failed must not
  // throw: the baseline did nothing wrong. Keep it and say why.
  const dir = tree([
    { file: 'x.ifc', timestamp: '2026-10-10', metrics: { totalWallClockMs: 900 }, gpuHealth: lost },
    { file: 'y.ifc', timestamp: '2026-10-10', metrics: { totalWallClockMs: 950 }, gpuHealth: lost },
  ]);
  try {
    const { code, out } = run(dir);
    const baseline = baselineOf(dir);
    assert.equal(code, 0, out);
    assert.match(out, /every result lost its GPU device mid-sample; all previous entries kept/);
    assert.deepEqual(baseline, { 'x.ifc': OLD, 'y.ifc': OLD });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
