/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/instructions-report.mjs (#6958).
 *
 * The reporter folds one callgrind run's per-marker dumps into per-phase
 * instruction counts. What these tests pin:
 *   - each dump is the segment its marker CLOSES, so parse includes the
 *     untimed code between its sub-phases (exactly like parse_time_ms), and
 *     total excludes the probe's own work before and after the pipeline;
 *   - a run without markers (probe built without `phase-markers`) or with a
 *     marker firing twice (more than one pipeline run) is refused, never
 *     reported as a partial or doubled count.
 *
 * The CLI is driven as a child process over real dump files, the way
 * instructions.sh calls it. Assertion messages never echo the child's stderr.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./instructions-report.mjs', import.meta.url));
const MARKER = (name) => `--dump-before=ifc_lite_processing::processor::phase_marks::${name}`;

/** A callgrind dump as `--dump-instr=no --dump-line=no` writes it. */
function dump(part, trigger, ir) {
  return [
    '# callgrind format',
    'version: 1',
    'creator: callgrind-3.26.0',
    'pid: 4242',
    'cmd:  perf_probe fixture.ifc --iters 1 --single-thread --json',
    `part: ${part}`,
    '',
    'desc: I1 cache: ',
    'desc: Timerange: Basic block 0 - 10',
    `desc: Trigger: ${trigger}`,
    '',
    'positions: line',
    'events: Ir',
    `summary: ${ir}`,
    '',
    'fn=(1) main',
    `0 ${ir}`,
    '',
    `totals: ${ir}`,
    '',
  ].join('\n');
}

/** One pipeline run: [marker, Ir of the segment it closes]. */
const RUN = [
  ['pipeline_start', 1000],
  ['entity_scan_end', 600],
  ['lookup_start', 7],
  ['lookup_end', 130],
  ['preprocess_start', 18],
  ['preprocess_end', 260],
  ['parse_end', 1],
  ['geometry_start', 3],
  ['geometry_end', 3600],
  ['total_end', 17],
];
const EXIT_IR = 80;
const PROBE = [{ path: 'fixture.ifc', meshes: 285, vertices: 35940, triangles: 20322 }];

function runReport(markers, { probe = PROBE, exitDump = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'instructions-report-'));
  try {
    markers.forEach(([name, ir], i) => {
      writeFileSync(join(dir, `callgrind.out.${i + 1}`), dump(i + 1, MARKER(name), ir));
    });
    if (exitDump) writeFileSync(join(dir, 'callgrind.out'), dump(markers.length + 1, 'Program termination', EXIT_IR));
    writeFileSync(join(dir, 'probe.json'), JSON.stringify(probe));
    const r = spawnSync(process.execPath, [
      CLI, '--dumps', join(dir, 'callgrind.out'), '--probe', join(dir, 'probe.json'),
      '--fixture', 'fixture.ifc', '--commit', 'abc1234', '--json',
    ], { encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('each dump is the segment its marker closes; phases mirror the ProcessingStats windows', () => {
  const r = runReport(RUN);
  assert.equal(r.status, 0, 'the report CLI must succeed on a complete run');
  const report = JSON.parse(r.stdout);
  assert.equal(report.fixture, 'fixture.ifc');
  assert.equal(report.commit, 'abc1234');
  assert.deepEqual(report.phases, {
    // entity scan 600 + lookup 130 + preprocess 260 + untimed 7 + 18 + 1
    parseIr: 1016,
    entityScanIr: 600,
    lookupIr: 130,
    preprocessIr: 260,
    geometryIr: 3600,
    // parse 1016 + untimed 3 + 17 + geometry 3600; NOT the 1000 before or 80 after
    totalIr: 4636,
  });
  assert.deepEqual(report.outside, { beforePipelineIr: 1000, afterPipelineIr: EXIT_IR });
  assert.equal(report.processIr, 1000 + 4636 + EXIT_IR, 'segments must add up to the whole process');
  assert.deepEqual([report.meshes, report.vertices, report.triangles], [285, 35940, 20322]);
});

test('a probe built without phase-markers is refused, not reported as zero phases', () => {
  const r = runReport([]);
  assert.equal(r.status, 1, 'a markerless run must fail');
  assert.ok(/--features phase-markers/.test(r.stderr), 'the failure must name the missing feature');
  assert.equal(r.stdout, '', 'no report may be printed');
});

test('two pipeline runs in one process are refused, not summed', () => {
  const r = runReport([...RUN, ...RUN]);
  assert.equal(r.status, 1, 'a doubled run must fail');
  assert.ok(/--iters 1/.test(r.stderr), 'the failure must say to run one iteration');
});

test('a missing marker is refused', () => {
  const r = runReport(RUN.filter(([name]) => name !== 'lookup_start'));
  assert.equal(r.status, 1, 'an incomplete run must fail');
});

test('a run without the program-termination dump is refused', () => {
  const r = runReport(RUN, { exitDump: false });
  assert.equal(r.status, 1, 'a truncated run must fail');
});

test('the probe must report exactly one fixture', () => {
  const r = runReport(RUN, { probe: [...PROBE, ...PROBE] });
  assert.equal(r.status, 1, 'two probe results must fail');
});
