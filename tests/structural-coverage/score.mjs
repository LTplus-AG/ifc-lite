#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural coverage scorer: derives the catalogue, runs every registered
 * probe over the fixture corpus, and scores the result.
 *
 * Scoring. A cell (row x applicable level) earns 1 for pass, 0.5 for partial,
 * 0 for anything else (fail, error, skip, unwritten). A row is met when every
 * applicable cell passes (1), partial when any cell earns (0.5), else missing.
 * `total` is the row score; `cells` and `levels` show progress inside rows.
 * skip never counts as a pass. An empty catalogue or denominator is refused.
 *
 * Usage:
 *   node tests/structural-coverage/score.mjs [--check baseline.json] [--out summary.json] [--offline] [--quiet]
 *     --check    exit 1 when the total, the cell score, any row, or any cell is below the baseline,
 *                or the set of rows or applicable cells differs from it
 *     --offline  score absent corpus files as skip instead of exiting 2 (the result is marked offline)
 *
 * Builds the packages it imports (parser, mutations, create, export) with Turbo
 * and needs the corpus fetched (`node scripts/fixtures/fetch-fixtures.mjs <paths>`);
 * a failed build or a missing fixture exits 2.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../../scripts/lib/is-main-entry.mjs';
import { LEVELS, deriveCatalogue, notApplicable } from './catalogue.mjs';
import { loadCorpus } from './lib/corpus.mjs';
import { loadPackages } from './lib/packages.mjs';
import { PROBES } from './probes/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SUMMARY_SCHEMA = 'ifclite-structural-coverage/1';
const RANK = { pass: 5, partial: 4, fail: 3, error: 2, skip: 1, unwritten: 0 };
const POINTS = { pass: 1, partial: 0.5 };
const ROW_RANK = { met: 2, partial: 1, missing: 0 };
const clip = (s, n = 600) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The product logs diagnostics (spatial hierarchy, units) while parsing. A probe
 * reports through its result, so its console output is dropped, not interleaved
 * with the scorecard.
 */
async function quiet(fn) {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved)) console[k] = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Run every probe; return row id -> level -> best result. Throws when an applicable cell has no probe. */
export async function runProbes(rows, ctx, probes = PROBES) {
  const cells = new Map(rows.map((r) => [r.id, {}]));
  for (const probe of probes) {
    const mine = rows.filter((r) => notApplicable(r, probe.level) === null && (!probe.covers || probe.covers(r)));
    if (!mine.length) continue;
    let results;
    try {
      results = await quiet(() => probe.run(mine, ctx));
    } catch (e) {
      results = new Map(mine.map((r) => [r.id, { status: 'error', reason: `${probe.name} threw: ${e.message}` }]));
    }
    for (const row of mine) {
      const r = results.get(row.id) ?? { status: 'error', reason: `${probe.name} returned no result for this row` };
      const status = r.status in RANK ? r.status : 'error';
      const cell = { status, probe: probe.name, ...(r.reason ? { reason: clip(r.reason) } : {}), ...(r.counts ? { counts: r.counts } : {}), ...(r.evidence?.length ? { evidence: [...r.evidence].sort().slice(0, 5) } : {}) };
      const prev = cells.get(row.id)[probe.level];
      if (!prev || RANK[cell.status] > RANK[prev.status] || (RANK[cell.status] === RANK[prev.status] && cell.probe < prev.probe)) {
        cells.get(row.id)[probe.level] = cell;
      }
    }
  }
  const unprobed = rows.flatMap((r) => LEVELS.filter((l) => notApplicable(r, l) === null && !cells.get(r.id)[l]).map((l) => `${r.id} ${l}`));
  if (unprobed.length) throw new Error(`no probe registered for ${unprobed.length} applicable cell(s), e.g. ${unprobed.slice(0, 5).join(', ')}`);
  return cells;
}

/**
 * Every derived number of a summary, recomputed from its rows' cells: each
 * row's points, max and status, and the total, cell and per-level totals.
 * Pure. Nothing a summary file states about its totals is taken on trust.
 */
export function tally(rows) {
  const levelTotals = Object.fromEntries(LEVELS.map((l) => [l, { score: 0, max: 0, pass: 0, partial: 0, fail: 0, error: 0, skip: 0, unwritten: 0 }]));
  const out = rows.map((row) => {
    let points = 0;
    let max = 0;
    for (const level of LEVELS) {
      const cell = row.levels[level];
      // Every level has a cell (not-applicable ones say so); a missing one is a damaged summary, never a skip.
      if (!cell) throw new Error(`${row.id} ${level}: no cell`);
      if (cell.applicable === false) continue;
      const p = POINTS[cell.status] ?? 0;
      points += p;
      max++;
      levelTotals[level].score += p;
      levelTotals[level].max++;
      levelTotals[level][cell.status]++;
    }
    // Only a pass earns a full point, so every applicable cell passes exactly when points === max.
    const { levels, ...head } = row;
    return { ...head, status: points === max ? 'met' : points > 0 ? 'partial' : 'missing', points, max, levels };
  });
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const r of out) counts[r.status]++;
  const cellsMax = out.reduce((a, r) => a + r.max, 0);
  if (!out.length || cellsMax === 0) throw new Error('score: empty denominator (no rows or no applicable cells); refusing to score');
  return {
    total: { score: counts.met + counts.partial * 0.5, max: out.length, ...counts },
    cells: { score: out.reduce((a, r) => a + r.points, 0), max: cellsMax },
    levels: Object.fromEntries(Object.entries(levelTotals).filter(([, t]) => t.max > 0)),
    rows: out,
  };
}

/** Where a summary's stored totals disagree with its own rows; empty when they agree. */
export function verifyTotals(summary) {
  let t;
  try {
    t = tally(summary.rows ?? []);
  } catch (e) {
    return [e.message];
  }
  const problems = [];
  for (const key of ['total', 'cells', 'levels']) {
    if (JSON.stringify(summary[key]) !== JSON.stringify(t[key])) problems.push(`${key}: stored ${JSON.stringify(summary[key])}, rows give ${JSON.stringify(t[key])}`);
  }
  summary.rows.forEach((r, i) => {
    const want = t.rows[i];
    if (r.status !== want.status || r.points !== want.points || r.max !== want.max) {
      problems.push(`${r.id}: stored ${r.status} ${r.points}/${r.max}, cells give ${want.status} ${want.points}/${want.max}`);
    }
  });
  return problems;
}

/**
 * Everything wrong with a stored summary that a rerun is not needed to see:
 * a cell whose applicability differs from the catalogue rule (marking a failing
 * cell not applicable drops it from every total), and totals that disagree
 * with the rows. `catalogueRows` is `deriveCatalogue(root).rows`.
 */
export function verifySummary(summary, catalogueRows) {
  if (!Array.isArray(summary.rows) || summary.rows.some((r) => !r || typeof r.levels !== 'object' || r.levels === null)) {
    return ['rows: every row must carry a levels object'];
  }
  const byId = new Map(catalogueRows.map((r) => [r.id, r]));
  const problems = [];
  for (const r of summary.rows) {
    const rule = byId.get(r.id);
    if (!rule) { problems.push(`${r.id}: not a catalogue row`); continue; }
    for (const l of LEVELS) {
      const storedNa = r.levels[l]?.applicable === false;
      if (storedNa !== (notApplicable(rule, l) !== null)) problems.push(`${r.id} ${l}: applicability differs from the catalogue rule`);
    }
  }
  return [...problems, ...verifyTotals(summary)];
}

/** Score probed cells. Pure. */
export function score(rows, cells, meta = {}) {
  const withCells = rows.map((row) => {
    const levels = {};
    for (const level of LEVELS) {
      const rule = notApplicable(row, level);
      levels[level] = rule ? { applicable: false, rule } : cells.get(row.id)[level];
    }
    const head = row.kind === 'entity'
      ? { id: row.id, kind: row.kind, schema: row.schema, entity: row.entity, family: row.family }
      : { id: row.id, kind: row.kind, title: row.title, round: row.round };
    return { ...head, levels };
  });
  return { schema: SUMMARY_SCHEMA, offline: meta.offline === true, absent: meta.absent ?? [], corpus: meta.corpus ?? [], ...tally(withCells) };
}

/** Every way `current` is worse than `baseline`; empty means the check passes. */
export function ratchet(baseline, current) {
  const problems = [];
  if (current.offline) problems.push(`current run is offline (${current.absent.length} corpus file(s) absent); fetch them and re-run`);
  if (current.total.score < baseline.total.score) problems.push(`total dropped from ${baseline.total.score} to ${current.total.score}`);
  if (current.cells.score < baseline.cells.score) problems.push(`cell score dropped from ${baseline.cells.score} to ${current.cells.score}`);
  const now = new Map(current.rows.map((r) => [r.id, r]));
  const was = new Set(baseline.rows.map((r) => r.id));
  const added = current.rows.filter((r) => !was.has(r.id)).map((r) => r.id);
  if (added.length) problems.push(`rows not in the baseline: ${added.join(', ')} (re-baseline deliberately)`);
  for (const b of baseline.rows) {
    const c = now.get(b.id);
    if (!c) { problems.push(`${b.id}: row is gone (was ${b.status})`); continue; }
    if (ROW_RANK[c.status] < ROW_RANK[b.status]) problems.push(`${b.id}: ${b.status} -> ${c.status}`);
    for (const level of LEVELS) {
      const bc = b.levels[level];
      const cc = c.levels[level];
      if ((bc?.applicable === false) !== (cc?.applicable === false)) { problems.push(`${b.id} ${level}: applicability changed`); continue; }
      if (bc?.applicable === false) continue;
      if ((POINTS[cc?.status] ?? 0) < (POINTS[bc?.status] ?? 0)) problems.push(`${b.id} ${level}: ${bc.status} -> ${cc?.status}`);
    }
  }
  return problems;
}

/** Pretty header, one line per row and per corpus file, so a baseline diff shows which rows moved. */
export function serialize(summary) {
  const { rows, corpus, ...head } = summary;
  const list = (items) => `[\n${items.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
  const top = JSON.stringify(head, null, 2).slice(0, -2);
  return `${top},\n  "corpus": ${list(corpus)},\n  "rows": ${list(rows)}\n}\n`;
}

function print(s) {
  const pad = (x, n) => String(x).padEnd(n);
  const MARK = { pass: 'pass', partial: 'part', fail: 'FAIL', error: 'ERR', skip: 'skip', unwritten: 'todo' };
  console.log(`${pad('row', 52)} ${LEVELS.map((l) => pad(l.slice(0, 5), 5)).join(' ')} row`);
  for (const r of s.rows) {
    console.log(`${pad(r.id, 52)} ${LEVELS.map((l) => pad(r.levels[l].applicable === false ? '-' : MARK[r.levels[l].status], 5)).join(' ')} ${r.status}`);
  }
  const t = s.total;
  console.log(`\nTotal: ${t.score} / ${t.max} rows (met ${t.met}, partial ${t.partial}, missing ${t.missing}); cells ${s.cells.score} / ${s.cells.max}${s.offline ? ' [OFFLINE]' : ''}`);
  console.log(Object.entries(s.levels).map(([l, v]) => `${l} ${v.score}/${v.max}`).join(' · '));
}

async function main(argv) {
  // Strict: a valued flag without its value, or a misspelt flag, exits 2 instead of running without the ratchet.
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      out: { type: 'string' }, check: { type: 'string' }, offline: { type: 'boolean' }, quiet: { type: 'boolean' },
    } }));
  } catch (e) {
    console.error(`score: ${e.message}`);
    return 2;
  }
  const rel = (p) => relative(ROOT, p).split('\\').join('/');
  const out = resolve(values.out ?? join(ROOT, 'tests/structural-coverage/.out/summary.json'));
  const check = values.check ? resolve(values.check) : null;
  if (check && (check === out || (existsSync(out) && existsSync(check) && realpathSync(check) === realpathSync(out)))) {
    console.error(`score: --out and --check both name ${rel(out)}; write the summary elsewhere, check it, then copy it over.`);
    return 2;
  }
  let catalogue;
  try {
    catalogue = deriveCatalogue(ROOT);
  } catch (e) {
    console.error(`score: ${e.message}`);
    return 2;
  }
  let baseline = null;
  if (check) {
    try {
      baseline = JSON.parse(readFileSync(check, 'utf8'));
    } catch (e) {
      console.error(`score: cannot read the --check baseline ${rel(check)}: ${e.message}`);
      return 2;
    }
    if (baseline?.schema !== SUMMARY_SCHEMA) { console.error(`score: ${rel(check)} is not an ${SUMMARY_SCHEMA} summary`); return 2; }
    const forged = verifySummary(baseline, catalogue.rows);
    if (forged.length) { console.error(`score: ${rel(check)}: its stored totals or applicability disagree with its rows and the catalogue:\n  ${forged.slice(0, 5).join('\n  ')}`); return 2; }
    // Same refusal and remedy as the ledger gate (scripts/check-generated.mjs).
    if (baseline.offline) { console.error(`score: ${rel(check)} was scored offline (${baseline.absent?.length ?? 0} corpus file(s) absent); fetch the missing corpus fixtures and re-score without --offline, then re-baseline`); return 2; }
  }
  let summary;
  try {
    const { rows, tables } = catalogue;
    const corpus = loadCorpus(ROOT, { offline: values.offline === true });
    const pkgs = await loadPackages(ROOT);
    const cells = await runProbes(rows, { root: ROOT, rows, tables, corpus, pkgs, cache: new Map() });
    summary = score(rows, cells, {
      offline: corpus.absent.length > 0,
      absent: corpus.absent.map((a) => a.path),
      corpus: corpus.files.map((f) => ({ path: f.path, sha256: f.sha256, schema: f.fileSchema })),
    });
  } catch (e) {
    console.error(`score: ${e.message}`);
    return 2;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serialize(summary));
  if (!values.quiet) print(summary);
  console.log(`Summary written to ${rel(out)}`);
  if (check) {
    const problems = ratchet(baseline, summary);
    if (problems.length) {
      console.error(`\nRatchet FAILED against ${rel(check)}:\n  ${problems.join('\n  ')}`);
      return 1;
    }
    console.log(`Ratchet OK against ${rel(check)}: total ${summary.total.score} >= ${baseline.total.score}, cells ${summary.cells.score} >= ${baseline.cells.score}, no row or cell dropped.`);
  }
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
