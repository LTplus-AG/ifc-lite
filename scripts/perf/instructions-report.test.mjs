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

// Own code only: libc's alignment-dependent instruction counts must not reach
// the phases, while our own call sites (and so a change that calls libc more
// often) still do.
const LIBC = '/usr/lib/x86_64-linux-gnu/libc.so.6';
/** A dump in which our scanner spends `own` Ir itself and calls memcmp `calls` times costing `memcmp` Ir. */
function splitDump(part, trigger, { own, memcmp, calls }) {
  return [
    '# callgrind format', 'version: 1', 'cmd:  /x/perf_probe fixture.ifc --iters 1', `part: ${part}`,
    `desc: Trigger: ${trigger}`, 'positions: line', 'events: Ir', `summary: ${own + memcmp}`, '',
    'ob=(1) /x/target/profiling/examples/perf_probe', 'fl=(1) ???', 'fn=(1) ifc_lite_core::scan::next',
    `0 ${own}`,
    `cob=(2) ${LIBC}`, 'cfi=(2) ???', 'cfn=(2) __memcmp_avx2_movbe', `calls=${calls} 0`, `0 ${memcmp}`,
    '', 'ob=(2)', 'fl=(2)', 'fn=(2)', `0 ${memcmp}`, '', `totals: ${own + memcmp}`, '',
  ].join('\n');
}

test('selfCosts splits own code from system libraries and counts the calls between them', async () => {
  const { selfCosts, isSystemObject } = await import('./instructions-report.mjs');
  assert.deepEqual(selfCosts(splitDump(1, 'x', { own: 500, memcmp: 4000, calls: 37 })), { own: 500, system: 4000, externalCalls: 37 });
  for (const lib of [LIBC, '/lib64/ld-linux-x86-64.so.2', '/usr/lib/libgcc_s.so.1', '[vdso]', '/usr/libexec/valgrind/vgpreload_core-amd64-linux.so']) assert.ok(isSystemObject(lib), lib);
  assert.ok(!isSystemObject('/x/target/profiling/examples/perf_probe'));
  // Two position columns (`--dump-instr=yes`): Ir is the column after them.
  const instr = 'positions: instr line\nevents: Ir\nob=(1) /x/perf_probe\nfn=(1) f\n0x10 3 70\n';
  assert.deepEqual(selfCosts(instr), { own: 70, system: 0, externalCalls: 0 });
});

test('a layout-only change inside libc moves allObjects, not phases; more calls into libc move phases', () => {
  const run = (memcmp, own = 600, calls = 40) => {
    const dir = mkdtempSync(join(tmpdir(), 'instructions-report-own-'));
    try {
      RUN.forEach(([name, ir], i) => {
        const text = name === 'entity_scan_end' ? splitDump(i + 1, MARKER(name), { own, memcmp, calls }) : dump(i + 1, MARKER(name), ir);
        writeFileSync(join(dir, `callgrind.out.${i + 1}`), text);
      });
      writeFileSync(join(dir, 'callgrind.out'), dump(RUN.length + 1, 'Program termination', EXIT_IR));
      writeFileSync(join(dir, 'probe.json'), JSON.stringify(PROBE));
      const r = spawnSync(process.execPath, [CLI, '--dumps', join(dir, 'callgrind.out'), '--probe', join(dir, 'probe.json'), '--json'], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(r.status, 0, 'the report CLI must succeed');
      return JSON.parse(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const base = run(4000);
  const shifted = run(4310); // same calls, memcmp retired more instructions on other alignments
  assert.equal(base.phases.entityScanIr, 600);
  assert.deepEqual(shifted.phases, base.phases);
  assert.equal(shifted.allObjects.entityScanIr - base.allObjects.entityScanIr, 310);
  assert.equal(base.externalCalls.entityScanCalls, 40);
  // Twice the calls: the call sites are our instructions, so the phase grows.
  const doubled = run(8000, 640, 80);
  assert.ok(doubled.phases.entityScanIr > base.phases.entityScanIr);
  assert.equal(doubled.externalCalls.entityScanCalls, 80);
});
