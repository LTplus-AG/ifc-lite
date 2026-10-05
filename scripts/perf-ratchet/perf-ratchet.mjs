#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Perf ratchet CLI (#6959). Ceilings are committed per family at
 * `tests/perf-ratchets/<family>.json`; a family's measurer
 * (`scripts/perf-ratchet/measure-<family>.mjs`) writes a measured JSON file.
 *
 *   node scripts/perf-ratchet/perf-ratchet.mjs check --measured <file> [--measured <file>...]
 *        [--measured-dir <dir>] [--ceilings-dir <dir>] [--markdown <out.md>]
 *     Compare each measured file with its family's ceilings. Exit 1 when any
 *     value exceeds its ceiling plus tolerance, when a ceiling has no
 *     measurement, or when a measured id has no ceiling. Prints (and with
 *     --markdown writes) a table of the moved metrics; improvements are noted.
 *
 *   node scripts/perf-ratchet/perf-ratchet.mjs lower --measured <file> [...]
 *        [--ceilings-dir <dir>] [--changelog <out.md>] [--dry-run]
 *     Rewrite ceilings DOWN to the measured values where they cleared their
 *     band (never up), re-stamp provenance with the measured commit, and print
 *     an old -> new changelog. Used by .github/workflows/perf-ratchet-lower.yml.
 *
 * Exit 2 is a harness fault (bad arguments, unreadable or invalid files) and
 * is kept distinct from exit 1, a real ceiling breach.
 *
 * Adding a family: write `measure-<family>.mjs` emitting the measured shape in
 * `ceilings.mjs`, commit `tests/perf-ratchets/<family>.json` seeded from a
 * real measurement, and pass the measured file to `check` in CI and to
 * `lower` in the daily workflow. Nothing in this file changes.
 */

import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { ceilingPath, loadCeilingFile, loadMeasuredFile, serializeCeilingFile } from './ceilings.mjs';
import { compareFamily } from './compare.mjs';
import { lowerFamily, formatChangelog } from './lower.mjs';
import { formatReport } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CEILINGS_DIR = join(ROOT, 'tests/perf-ratchets');

/** @returns {{ command: string, measured: string[], ceilingsDir: string, markdown?: string, changelog?: string, dryRun: boolean }} */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'lower') throw new Error('usage: perf-ratchet.mjs <check|lower> --measured <file> [options]');
  const opts = { command, measured: [], ceilingsDir: DEFAULT_CEILINGS_DIR, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--measured') opts.measured.push(resolve(value()));
    else if (flag === '--measured-dir') {
      const dir = resolve(value());
      if (!existsSync(dir)) throw new Error(`--measured-dir ${dir} does not exist`);
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) opts.measured.push(join(dir, f));
    } else if (flag === '--ceilings-dir') opts.ceilingsDir = resolve(value());
    else if (flag === '--markdown' && command === 'check') opts.markdown = resolve(value());
    else if (flag === '--changelog' && command === 'lower') opts.changelog = resolve(value());
    else if (flag === '--dry-run' && command === 'lower') opts.dryRun = true;
    else throw new Error(`unknown option for ${command}: ${flag}`);
  }
  // Fail closed: a check over zero measurements would print a green table
  // having compared nothing.
  if (opts.measured.length === 0) throw new Error('no measured file given (--measured or --measured-dir)');
  return opts;
}

function loadPairs(opts) {
  const families = new Set();
  return opts.measured.map((file) => {
    const measured = loadMeasuredFile(file);
    if (families.has(measured.family)) throw new Error(`two measured files for family \`${measured.family}\``);
    families.add(measured.family);
    const path = ceilingPath(opts.ceilingsDir, measured.family);
    return { measured, path, ceilings: loadCeilingFile(path) };
  });
}

export function runCheck(opts, log = console.log) {
  const pairs = loadPairs(opts);
  const results = pairs.map(({ ceilings, measured }) => compareFamily(ceilings, measured));
  const commits = [...new Set(pairs.map((p) => p.measured.commit))];
  const report = formatReport(results, { commit: commits.join(', ') });
  log(report);
  if (opts.markdown) writeFileSync(opts.markdown, report);
  return results.some((r) => r.failed) ? 1 : 0;
}

export function runLower(opts, log = console.log) {
  const pairs = loadPairs(opts);
  const lowered = [];
  for (const { ceilings, measured, path } of pairs) {
    const { next, changes } = lowerFamily(ceilings, measured);
    lowered.push({ family: ceilings.family, changes });
    if (changes.length && !opts.dryRun) writeFileSync(path, serializeCeilingFile(next));
  }
  const commits = [...new Set(pairs.map((p) => p.measured.commit))];
  const changelog = formatChangelog(lowered, { commit: commits.join(', ') });
  log(changelog);
  if (opts.changelog) writeFileSync(opts.changelog, changelog);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    process.exitCode = opts.command === 'check' ? runCheck(opts) : runLower(opts);
  } catch (err) {
    console.error(`perf-ratchet: ${err.message}`);
    process.exitCode = 2;
  }
}
