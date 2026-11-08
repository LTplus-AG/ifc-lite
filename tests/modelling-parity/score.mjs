#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modelling-parity scorecard (#9296): the objective score the hill climb ratchets on.
 *
 * Reads every `*.json` / `*.jsonl` under the given directories (default
 * `tests/modelling-parity/.out`), keeps the `ifclite-parity-result/1` records
 * (a file may hold one record, an array, or JSON lines), and per catalogue row:
 *   - takes the BEST status per probe level (pass > partial > fail > error > skip);
 *   - combines sdk/ui/output into the row status: met when every APPLICABLE level's
 *     best is pass, partial when any of them is pass or partial, missing otherwise
 *     (exercise and perf results are reported alongside, not scored);
 *   - scores table-stakes rows met = 1, partial = 0.5, out of the table-stakes count.
 * `skip` never counts as a pass.
 *
 * Usage:
 *   node tests/modelling-parity/score.mjs [DIR ...] [--out summary.json] [--check baseline.json] [--quiet]
 *     --out    where the JSON summary goes (default tests/modelling-parity/.out/summary.json)
 *     --check  ratchet: exit 1 if the score or any row's status is below the baseline summary's;
 *              the baseline is read first, and --out naming the same file is refused (exit 2)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../scripts/lib/is-main-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
export const RESULT_SCHEMA = 'ifclite-parity-result/1';
export const SUMMARY_SCHEMA = 'ifclite-parity-summary/1';
export const LEVELS = ['sdk', 'ui', 'output'];
export const SIDE_LEVELS = ['exercise', 'perf'];
const STATUS_RANK = { pass: 4, partial: 3, fail: 2, error: 1, skip: 0 };
export const ROW_RANK = { met: 2, partial: 1, missing: 0 };
const rel = (p) => relative(ROOT, p).split('\\').join('/') || '.';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsonl?$/.test(name)) out.push(p);
  }
  return out;
}

function parseRecords(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    return text.split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
}

/** All result records under `dirs`, plus the files they came from. */
export function readResults(dirs) {
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new Error(`score: result directory ${dir} does not exist`);
    for (const file of walk(dir)) {
      for (const r of parseRecords(readFileSync(file, 'utf8'))) {
        if (r && typeof r === 'object' && r.schema === RESULT_SCHEMA) results.push({ ...r, file: rel(file) });
      }
    }
  }
  return results;
}

function best(records) {
  if (!records.length) return { status: 'none', results: 0 };
  const top = records.slice().sort((a, b) => (STATUS_RANK[b.status] ?? -1) - (STATUS_RANK[a.status] ?? -1) || String(a.id).localeCompare(String(b.id)))[0];
  return {
    status: STATUS_RANK[top.status] === undefined ? 'error' : top.status,
    id: top.id,
    ...(top.status === 'pass' ? {} : { reason: top.reason ?? 'no reason given' }),
    results: records.length,
    ...(top.source ? { source: top.source } : {}),
  };
}

/** Score `results` against `catalogue`. Pure: no I/O, so tests can call it directly. */
export function score(catalogue, results, meta = {}) {
  const known = new Set(catalogue.capabilities.map((c) => c.id));
  const unknown = [...new Set(results.filter((r) => !known.has(r.capability)).map((r) => r.capability))].sort();
  const rows = catalogue.capabilities.map((cap) => {
    const mine = results.filter((r) => r.capability === cap.id);
    const levels = {};
    for (const level of [...LEVELS, ...SIDE_LEVELS]) {
      const b = best(mine.filter((r) => r.probe === level));
      const applicable = LEVELS.includes(level) ? cap.probes?.[level]?.applicable !== false : true;
      levels[level] = { ...b, ...(applicable ? {} : { applicable: false }) };
    }
    const scored = LEVELS.filter((l) => levels[l].applicable !== false);
    const status = scored.length && scored.every((l) => levels[l].status === 'pass') ? 'met'
      : LEVELS.some((l) => ['pass', 'partial'].includes(levels[l].status)) ? 'partial' : 'missing';
    return { capability: cap.id, title: cap.title, group: cap.group, tableStakes: cap.tableStakes === true, status, levels };
  });
  const stakes = rows.filter((r) => r.tableStakes);
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const r of stakes) counts[r.status]++;
  const sources = [...new Map(results.filter((r) => r.source?.commit).map((r) => [`${r.source.commit}${r.source.dirty ? '+dirty' : ''}`, r.source])).values()];
  return {
    schema: SUMMARY_SCHEMA,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    inputs: meta.inputs ?? [],
    sources,
    results: results.length,
    score: counts.met + counts.partial * 0.5,
    maxScore: stakes.length,
    counts,
    ...(unknown.length ? { unknownCapabilities: unknown } : {}),
    rows,
  };
}

/** Ratchet: every way `current` is worse than `baseline`. Empty means the check passes. */
export function ratchet(baseline, current) {
  const problems = [];
  if (current.score < baseline.score) problems.push(`score dropped from ${baseline.score} to ${current.score}`);
  const now = new Map(current.rows.map((r) => [r.capability, r]));
  for (const was of baseline.rows) {
    const is = now.get(was.capability);
    if (!is) { problems.push(`${was.capability}: row is gone (was ${was.status})`); continue; }
    if (ROW_RANK[is.status] < ROW_RANK[was.status]) problems.push(`${was.capability}: ${was.status} -> ${is.status}`);
  }
  return problems;
}

/** Per-level drops; reported by --check as warnings, not failures. */
export function levelDrops(baseline, current) {
  const now = new Map(current.rows.map((r) => [r.capability, r]));
  const out = [];
  for (const was of baseline.rows) {
    const is = now.get(was.capability);
    if (!is) continue;
    for (const l of [...LEVELS, ...SIDE_LEVELS]) {
      const a = STATUS_RANK[was.levels?.[l]?.status] ?? -1, b = STATUS_RANK[is.levels?.[l]?.status] ?? -1;
      if (b < a) out.push(`${was.capability} ${l}: ${was.levels[l].status} -> ${is.levels[l]?.status ?? 'none'}`);
    }
  }
  return out;
}

const MARK = { pass: 'pass', partial: 'part', fail: 'FAIL', error: 'ERR', skip: 'skip', none: '-' };

function print(summary) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('capability', 44)} ${LEVELS.map((l) => pad(l, 6)).join(' ')} ${pad('exer', 5)} row`);
  for (const r of summary.rows) {
    const cells = LEVELS.map((l) => pad(r.levels[l].applicable === false ? 'n/a' : MARK[r.levels[l].status], 6));
    console.log(`${pad(`${r.tableStakes ? '' : '(+) '}${r.capability}`, 44)} ${cells.join(' ')} ${pad(MARK[r.levels.exercise.status], 5)} ${r.status}`);
  }
  const c = summary.counts;
  console.log(`\nTable-stakes score: ${summary.score} / ${summary.maxScore} (met ${c.met}, partial ${c.partial}, missing ${c.missing}) from ${summary.results} results`);
  if (summary.unknownCapabilities) console.warn(`warning: results name capabilities missing from the catalogue: ${summary.unknownCapabilities.join(', ')}`);
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
  const valued = new Set(['--out', '--check', '--catalogue']);
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1])).map((d) => resolve(d));
  const inputs = dirs.length ? dirs : [join(ROOT, 'tests/modelling-parity/.out')];
  const catalogue = JSON.parse(readFileSync(resolve(flag('--catalogue') ?? join(ROOT, 'tests/modelling-parity/catalogue.json')), 'utf8'));
  const out = resolve(flag('--out') ?? join(ROOT, 'tests/modelling-parity/.out/summary.json'));
  const check = flag('--check') ? resolve(flag('--check')) : null;
  // Read the baseline before anything is written: --out must never replace the file it is checked against.
  const sameFile = (a, b) => a === b || (existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b));
  if (check && sameFile(check, out)) {
    console.error(`score: --out and --check both name ${rel(out)}; a regressed summary would overwrite the baseline it is checked against. Write the summary elsewhere, check it, then copy it over.`);
    return 2;
  }
  const baseline = check ? JSON.parse(readFileSync(check, 'utf8')) : null;
  const summary = score(catalogue, readResults(inputs), { inputs: inputs.map(rel) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  if (!argv.includes('--quiet')) print(summary);
  console.log(`Summary written to ${rel(out)}`);
  if (baseline) {
    for (const w of levelDrops(baseline, summary)) console.warn(`level drop (warning): ${w}`);
    const problems = ratchet(baseline, summary);
    if (problems.length) {
      console.error(`\nRatchet FAILED against ${rel(check)} (baseline score ${baseline.score}):\n  ${problems.join('\n  ')}`);
      return 1;
    }
    console.log(`Ratchet OK against ${rel(check)}: ${summary.score} >= ${baseline.score}, no row dropped.`);
  }
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
