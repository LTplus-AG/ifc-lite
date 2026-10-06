#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurer for the native instruction-count families (#6982, charter #6954).
 * Runs `scripts/perf/instructions.sh --json` (perf_probe, single thread, under
 * callgrind, built with `phase-markers`) on a fixture and writes the measured
 * JSON that `perf-ratchet.mjs check|lower` consumes.
 *
 *   node scripts/perf-ratchet/measure-native-instructions.mjs --set <small|large>
 *        [--out <file>] [--commit <sha>]
 *
 * Two families, because a measured file must cover every entry of its family
 * and callgrind is ~60-100x slower than a native run:
 *
 *   native-instructions        --set small  AC20-FZK-Haus (~6 s under callgrind),
 *                                           measured on every Rust-affecting PR
 *   native-instructions-large  --set large  ISSUE_129 (~2.5 min), measured only
 *                                           by the daily perf-ratchet-lower.yml
 *
 * Metrics are `<fixture>.<phase>` instruction counts: parse (entity scan +
 * lookup + preprocess + untimed glue), its three parts, geometry, and total.
 * A phase that is ~0 Ir on a fixture is listed in that set's `skip`.
 * They mirror the ProcessingStats timer windows
 * (scripts/perf/instructions-report.mjs). Run-to-run variance is <= 1e-6, so
 * the ceiling's relative tolerance (0.05%) is a build-environment allowance,
 * not a noise allowance.
 *
 * SCOPE. Instruction counts gate per-element kernel and parse work. They do
 * not see scheduling, threading or browser-only effects (`--single-thread`);
 * those still need an end-to-end A/B (scripts/perf/README.md).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Report field -> metric id suffix, in pipeline order. */
export const PHASES = [
  ['parseIr', 'parse'],
  ['entityScanIr', 'entity-scan'],
  ['lookupIr', 'lookup'],
  ['preprocessIr', 'preprocess'],
  ['geometryIr', 'geometry'],
  ['totalIr', 'total'],
];

export const SETS = {
  small: { family: 'native-instructions', key: 'fzk-haus', fixture: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  large: {
    family: 'native-instructions-large',
    key: 'issue-129',
    fixture: 'tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc',
    // ~21k Ir (0.00007% of the total): a ceiling on it would gate nothing.
    skip: ['lookupIr'],
  },
};

/**
 * Turn one `instructions.sh --json` report into a measured file.
 *
 * @param {{ set: string, report: object, commit: string, measuredAt?: string }} opts
 */
export function buildMeasured({ set, report, commit, measuredAt = new Date().toISOString() }) {
  const def = SETS[set];
  if (!def) throw new Error(`unknown --set ${JSON.stringify(set)} (expected ${Object.keys(SETS).join(' or ')})`);
  const phases = report?.phases;
  if (!phases || typeof phases !== 'object') throw new Error('instructions.sh report has no `phases` object');
  const metrics = PHASES.filter(([field]) => !def.skip?.includes(field)).map(([field, name]) => {
    const value = phases[field];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`phase ${field} is ${JSON.stringify(value)} in the report; a zero or missing count means the run did not measure it`);
    }
    return { id: `${def.key}.${name}`, value, detail: `${field} Ir` };
  });
  return { family: def.family, commit, measuredAt, metrics };
}

/** Run instructions.sh for a set and return its parsed JSON. */
export function runInstructions(set, run = execFileSync) {
  const def = SETS[set];
  if (!def) throw new Error(`unknown --set ${JSON.stringify(set)}`);
  const out = run('bash', ['scripts/perf/instructions.sh', def.fixture, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 1 << 26,
  });
  return JSON.parse(out);
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function parseArgs(argv) {
  const opts = { set: null, out: null, commit: process.env.GITHUB_SHA || null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--set') opts.set = v;
    else if (flag === '--out') opts.out = resolve(v);
    else if (flag === '--commit') opts.commit = v;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!opts.set) throw new Error('--set <small|large> is required');
  return opts;
}

if (isMainEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = buildMeasured({ set: opts.set, report: runInstructions(opts.set), commit: opts.commit ?? gitHead() });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, json);
    }
    process.stdout.write(json);
  } catch (err) {
    console.error(`measure-native-instructions: ${err.message}`);
    process.exitCode = 2;
  }
}
