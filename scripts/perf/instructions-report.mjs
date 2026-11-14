#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reporter for scripts/perf/instructions.sh (#6958). Turns the callgrind dumps
// of one `perf_probe --single-thread --iters 1` run (built with the
// `phase-markers` feature) into per-phase instruction counts.
//
// callgrind writes one dump on entry to each phase marker
// (`--dump-before=...::phase_marks::*`) plus a final one at program exit. Each
// dump holds the instructions retired since the previous dump, so the dump a
// marker triggers is the segment that marker CLOSES. The segments add up to
// the whole process exactly; the phases below are sums of segments that mirror
// the ProcessingStats timer windows:
//
//   parseIr     pipeline start -> parse end (entity scan + lookup + preprocess
//               + the untimed code between them, exactly like parse_time_ms)
//   geometryIr  geometry start -> geometry end
//   totalIr     pipeline start -> total end (like total_time_ms; final
//               metadata assembly after the timer closes is NOT included)
//
// Usage:
//   node scripts/perf/instructions-report.mjs --dumps <callgrind.out> \
//     --probe <probe.json> --fixture <path> --commit <sha> [--json]
//
// `--dumps` is the --callgrind-out-file path; its numbered siblings
// (`<path>.1`, `<path>.2`, ...) are read too. Exit 1 on an unusable run.
//
// OWN CODE ONLY. `phases` counts the SELF cost of functions in the probe's own
// binary: ifc-lite and the Rust std and crates statically linked into it. The
// shared system libraries (libc, the dynamic loader, libgcc, the vDSO) are left
// out. glibc's string routines retire a number of instructions that depends on
// the alignment of the buffers they are given, so an unrelated change that
// shifts the binary's layout moved FZK's parse phases by up to ~0.14% through
// `__memcmp_avx2_movbe` alone; the count also depended on which glibc variant
// the host's CPU selects. Self cost rather than inclusive: the inclusive cost of
// our functions would pull those library bodies back in, while self cost keeps
// every call site's own instructions (argument setup, the call, the result
// test), so code that calls into libc more often still counts more.
// `externalCalls` (calls from the binary into those libraries, a deterministic
// count) and `allObjects` (the previous whole-process phases, libraries
// included) are reported beside it as information.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Marker function -> the segment its dump closes, in pipeline order. */
export const MARKERS = [
  ['pipeline_start', 'beforePipeline'],
  ['entity_scan_end', 'entityScan'],
  ['lookup_start', 'parseUntimed'],
  ['lookup_end', 'lookup'],
  ['preprocess_start', 'parseUntimed'],
  ['preprocess_end', 'preprocess'],
  ['parse_end', 'parseUntimed'],
  ['geometry_start', 'pipelineUntimed'],
  ['geometry_end', 'geometry'],
  ['total_end', 'pipelineUntimed'],
];
const EXIT_SEGMENT = 'afterPipeline';

/** Shared objects whose instructions are not ours: libc, ld.so, libgcc, the vDSO, valgrind preloads. */
export function isSystemObject(name) {
  return /\.so(\.\d+)*$/.test(name) || /^\[vdso\]$|vgpreload/.test(name);
}

/**
 * Self Ir per side of one dump, read from its cost lines: `own` (not a system
 * object), `system` (shared libraries), and `externalCalls` (calls from own code
 * into a system object). A cost line directly after `calls=` is the inclusive
 * cost of that call, already counted as the callee's self cost, so it is
 * skipped. Name compression (`ob=(3) /path`, later `ob=(3)`) is per file.
 */
export function selfCosts(text) {
  const names = new Map();
  const nameOf = (value) => {
    const m = value.match(/^\((\d+)\)(?:\s+(.*))?$/);
    if (!m) return value.trim();
    if (m[2] !== undefined) names.set(m[1], m[2].trim());
    return names.get(m[1]) ?? '';
  };
  let positions = 1;
  let ob = '';
  let cob = null;
  let calls = null;
  const out = { own: 0, system: 0, externalCalls: 0 };
  for (const line of text.split('\n')) {
    if (line.startsWith('positions:')) positions = line.slice(10).trim().split(/\s+/).filter(Boolean).length;
    else if (line.startsWith('ob=')) ob = nameOf(line.slice(3));
    else if (line.startsWith('cob=')) cob = nameOf(line.slice(4));
    else if (line.startsWith('calls=')) calls = Number(line.slice(6).trim().split(/\s+/)[0]);
    else if (/^[0-9+*-]/.test(line)) {
      const ir = Number(line.trim().split(/\s+/)[positions] ?? 0);
      if (!Number.isSafeInteger(ir)) throw new Error(`bad cost line: ${line}`);
      if (calls !== null) {
        if (!isSystemObject(ob) && isSystemObject(cob ?? ob)) out.externalCalls += calls;
        calls = null;
        cob = null;
      } else if (isSystemObject(ob)) out.system += ir;
      else out.own += ir;
    } else if (line.startsWith('fn=')) cob = null;
  }
  return out;
}
const MARKER_RE = /^--dump-before=.*::phase_marks::([a-z_]+)$/;

/** Parse one callgrind dump: its ordinal, trigger and Ir total. */
export function parseDump(text) {
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim();
  const events = field('events');
  if (events !== undefined && events.split(/\s+/)[0] !== 'Ir') {
    throw new Error(`dump does not count Ir first (events: ${events})`);
  }
  const trigger = field('desc: Trigger');
  const total = field('summary') ?? field('totals');
  if (trigger === undefined || total === undefined) {
    throw new Error('dump has no "desc: Trigger:" or no summary/totals line');
  }
  const ir = Number(total.split(/\s+/)[0]);
  if (!Number.isSafeInteger(ir) || ir < 0) throw new Error(`bad Ir total: ${total}`);
  const costs = selfCosts(text);
  if (costs.own + costs.system !== ir) {
    throw new Error(`self costs add up to ${costs.own + costs.system} Ir, the dump's total is ${ir}`);
  }
  return { part: Number(field('part') ?? 0), trigger, ir, ...costs };
}

/** Name of the segment a dump closes. */
export function segmentOf(trigger) {
  if (trigger === 'Program termination') return EXIT_SEGMENT;
  const marker = trigger.match(MARKER_RE)?.[1];
  const known = MARKERS.find(([name]) => name === marker);
  if (!known) throw new Error(`unexpected dump trigger: ${trigger}`);
  return known[1];
}

/**
 * Fold one run's dumps into phase counts. Requires exactly one pass through
 * every marker in pipeline order: a missing marker means the probe was built
 * without `phase-markers`; a repeated one means more than one pipeline run.
 */
export function phaseCounts(dumps) {
  const ordered = [...dumps].sort((a, b) => a.part - b.part);
  const markers = ordered.filter((d) => d.trigger !== 'Program termination');
  const seen = markers.map((d) => d.trigger.match(MARKER_RE)?.[1] ?? d.trigger);
  const expected = MARKERS.map(([name]) => name);
  if (seen.join(',') !== expected.join(',')) {
    const hint = seen.length === 0
      ? 'no phase markers fired: build perf_probe with --features phase-markers'
      : 'markers must fire once each, in order: run one fixture with --iters 1';
    throw new Error(`${hint} (saw [${seen.join(', ')}])`);
  }
  if (ordered.at(-1)?.trigger !== 'Program termination') {
    throw new Error('the final program-termination dump is missing');
  }
  const fold = (key) => {
    const segments = {};
    for (const dump of ordered) {
      const name = segmentOf(dump.trigger);
      segments[name] = (segments[name] ?? 0) + dump[key];
    }
    return segments;
  };
  const own = fold('own');
  const all = fold('ir');
  const calls = fold('externalCalls');
  return {
    phases: phasesOf(own),
    allObjects: phasesOf(all),
    externalCalls: phasesOf(calls, 'Calls'),
    outside: { beforePipelineIr: own.beforePipeline, afterPipelineIr: own.afterPipeline },
    processIr: ordered.reduce((sum, d) => sum + d.ir, 0),
  };
}

/** The ProcessingStats windows over one fold of segment counts, keyed `<phase><unit>`. */
function phasesOf(segments, unit = 'Ir') {
  const at = (name) => segments[name] ?? 0;
  const parse = at('entityScan') + at('lookup') + at('preprocess') + at('parseUntimed');
  return {
    [`parse${unit}`]: parse,
    [`entityScan${unit}`]: at('entityScan'),
    [`lookup${unit}`]: at('lookup'),
    [`preprocess${unit}`]: at('preprocess'),
    [`geometry${unit}`]: at('geometry'),
    [`total${unit}`]: parse + at('pipelineUntimed') + at('geometry'),
  };
}

/** Read `<path>` and its numbered siblings `<path>.N`. */
export function readDumps(path) {
  const dir = dirname(path);
  const stem = basename(path);
  const names = readdirSync(dir).filter((n) => n === stem || new RegExp(`^${escapeRe(stem)}\\.\\d+$`).test(n));
  if (names.length === 0) throw new Error(`no callgrind dumps at ${path}`);
  return names.map((n) => parseDump(readFileSync(join(dir, n), 'utf8')));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Combine the phase counts with the probe's own output counts. */
export function buildReport({ fixture, commit, dumps, probe }) {
  if (!Array.isArray(probe) || probe.length !== 1) {
    throw new Error(`expected one probe result, got ${Array.isArray(probe) ? probe.length : typeof probe}`);
  }
  const [p] = probe;
  return {
    fixture,
    commit,
    ...phaseCounts(dumps),
    meshes: p.meshes,
    vertices: p.vertices,
    triangles: p.triangles,
  };
}

export function formatReport(r) {
  const rows = [
    ['parse', r.phases.parseIr],
    ['  entity scan', r.phases.entityScanIr],
    ['  lookup/styles', r.phases.lookupIr],
    ['  preprocess', r.phases.preprocessIr],
    ['geometry', r.phases.geometryIr],
    ['total', r.phases.totalIr],
  ];
  const lines = [`${r.fixture} @ ${r.commit}`, `  ${r.meshes} meshes | ${r.vertices} verts | ${r.triangles} tris`];
  for (const [label, ir] of rows) lines.push(`  ${label.padEnd(16)} ${ir.toLocaleString('en-US').padStart(16)} Ir`);
  lines.push(`  (own code only; with system libraries the total is ${r.allObjects.totalIr.toLocaleString('en-US')} Ir,`);
  lines.push(`   ${r.externalCalls.totalCalls.toLocaleString('en-US')} calls into them; whole process ${r.processIr.toLocaleString('en-US')} Ir)`);
  return lines.join('\n');
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dumpsPath = opt('--dumps');
  const probePath = opt('--probe');
  if (!dumpsPath || !probePath) {
    console.error('usage: instructions-report.mjs --dumps <callgrind.out> --probe <probe.json> [--fixture P] [--commit SHA] [--json]');
    return 2;
  }
  try {
    const report = buildReport({
      fixture: opt('--fixture') ?? null,
      commit: opt('--commit') ?? null,
      dumps: readDumps(resolve(dumpsPath)),
      probe: JSON.parse(readFileSync(probePath, 'utf8')),
    });
    if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    return 0;
  } catch (error) {
    console.error(`instructions-report: ${error.message}`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
