#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Field verdict (#6961, perf charter #6954): the ledger's paired-ratio method
 * over PostHog field telemetry, per journey and per perf-flag arm.
 *
 * For every (event, metric, journey, person, model) cell that has rows in
 * both windows, the cell ratio is median(recent) / median(baseline). The
 * divisor comes from the baseline window ONLY and from the `default` arm only,
 * so a person whose loads are all recent, or all in a ramp arm, cannot cancel
 * out by construction (see "Reading the FIELD telemetry" in README.md).
 *
 * A group is judged per journey and per person: each person's median cell
 * ratio, then the median across people, above 1 is slower. Cells are not the
 * unit because one federated batch is dozens of them: on build 8d3ffe9d1f62
 * two people owned 28 of 42 cells, so the cell median read 1.86 while the
 * median person read 0.96. Pooling journeys hid the same batch in cold loads.
 *
 * `regressed` needs both the point estimate past the threshold (speed = 1 /
 * ratio below 0.95) and a 99% person bootstrap interval excluding 1, because a
 * nightly judges about ten metrics at once. Past the threshold without that is
 * `inconclusive`. Fewer people than `--min-persons` is `insufficient`: the
 * ratio is not small, it is undefined. Context metrics are reported and never
 * judged: `file_read_ms` barely depends on the app, so when it moves the
 * load comparison is suspect; `federated_session_loads` shows when a J4 change
 * comes with bigger batches.
 *
 * Input is the result of the HogQL in README.md (marker
 * `field-verdict-hogql`), as the PostHog query API returns it
 * (`{ columns, results }`), or an array of row objects. Offline by design:
 * the fetch lives in `field-verdict-fetch.mjs` and the workflow.
 *
 *   node scripts/perf/field-verdict.mjs result.json [--threshold 0.95] [--min-persons 5]
 *        [--build <sha>] [--json] [--fail-on-regression]
 *   node scripts/perf/field-verdict.mjs --print-sql --build <12-char sha> [--baseline-days 14]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const ROW_KEYS = ['event', 'journey', 'arm', 'person', 'model', 'metric', 'window', 'median', 'n'];
const README = new URL('./README.md', import.meta.url);
const SQL_MARKER = '<!-- field-verdict-hogql -->';

/** Rows from a PostHog query response (`{ columns, results }`), `{ results: [objects] }`, or an array of objects. */
export function parseRows(input) {
  const results = Array.isArray(input) ? input : input?.results;
  if (!Array.isArray(results)) throw new Error('field-verdict: input has no results array');
  const columns = Array.isArray(input?.columns) ? input.columns : null;
  return results.map((raw, i) => {
    const row = Array.isArray(raw)
      ? Object.fromEntries((columns ?? ROW_KEYS).map((key, j) => [key, raw[j]]))
      : raw;
    for (const key of ROW_KEYS) {
      if (row[key] === undefined || row[key] === null) throw new Error(`field-verdict: row ${i} has no ${key}`);
    }
    const median = Number(row.median);
    const n = Number(row.n);
    if (!Number.isFinite(median) || !Number.isFinite(n)) throw new Error(`field-verdict: row ${i} has a non-numeric median or n`);
    if (row.window !== 'baseline' && row.window !== 'recent') throw new Error(`field-verdict: row ${i} window must be baseline|recent`);
    return { ...row, arm: String(row.arm), median, n };
  });
}

const cellKey = (r) => [r.event, r.metric, r.journey, r.person, r.model].join('\u0000');

/**
 * Pair each recent cell with the same person's baseline cell for the same
 * model, journey and metric. Baseline rows outside `baselineArm` are not a
 * divisor. A zero or negative baseline median cannot divide and is skipped.
 */
export function pairCells(rows, { baselineArm = 'default' } = {}) {
  const baseline = new Map();
  for (const r of rows) {
    if (r.window === 'baseline' && r.arm === baselineArm) baseline.set(cellKey(r), r);
  }
  const cells = [];
  for (const r of rows) {
    if (r.window !== 'recent') continue;
    const base = baseline.get(cellKey(r));
    if (!base || !(base.median > 0)) continue;
    cells.push({
      event: r.event, metric: r.metric, journey: r.journey, arm: r.arm, person: r.person, model: r.model,
      ratio: r.median / base.median, recentN: r.n, baselineN: base.n,
    });
  }
  return cells;
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const CONTEXT_METRICS = new Set(['file_read_ms', 'federated_session_loads']);
const BOOTSTRAP_ROUNDS = 2000;
const BOOTSTRAP_SEED = 6961;

/** Small seeded generator, so one input always renders one verdict. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ascending = (values) => [...values].sort((a, b) => a - b);

/** 99% percentile interval of the median, resampling people. */
export function personInterval(personRatios, { rounds = BOOTSTRAP_ROUNDS, seed = BOOTSTRAP_SEED } = {}) {
  const random = seededRandom(seed);
  const medians = [];
  for (let round = 0; round < rounds; round++) {
    const sample = personRatios.map(() => personRatios[Math.floor(random() * personRatios.length)]);
    medians.push(quantile(ascending(sample), 0.5));
  }
  const sorted = ascending(medians);
  return [quantile(sorted, 0.005), quantile(sorted, 0.995)];
}

function summarize(key, cells, { threshold, minPersons }) {
  const byPerson = new Map();
  for (const c of cells) byPerson.set(c.person, [...(byPerson.get(c.person) ?? []), c.ratio]);
  const personRatios = ascending([...byPerson.values()].map((ratios) => quantile(ascending(ratios), 0.5)));
  const ratio = quantile(personRatios, 0.5);
  const speed = 1 / ratio;
  const [low, high] = personInterval(personRatios);
  let status;
  if (CONTEXT_METRICS.has(key.metric)) status = 'context';
  else if (personRatios.length < minPersons) status = 'insufficient';
  else if (speed < threshold) status = low > 1 ? 'regressed' : 'inconclusive';
  else if (speed > 1 / threshold) status = high < 1 ? 'improved' : 'inconclusive';
  else status = 'flat';
  return {
    ...key,
    cells: cells.length,
    persons: personRatios.length,
    loads: cells.reduce((sum, c) => sum + c.recentN + c.baselineN, 0),
    ratio: round(ratio),
    low: round(low),
    high: round(high),
    speed: round(speed),
    status,
  };
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

function groupBy(cells, keyOf) {
  const groups = new Map();
  for (const c of cells) {
    const key = keyOf(c);
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, cells: [] });
    groups.get(id).cells.push(c);
  }
  return [...groups.values()];
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a, b) => byText(a.event, b.event) || byText(a.journey, b.journey) || byText(a.metric, b.metric) || byText(a.arm, b.arm);

/**
 * The verdict per (event, metric, journey, arm). `regressed` lists the groups
 * judged slower; `controlMoved` the file read groups whose interval excludes 1
 * past the threshold, whose journey's load comparison is then suspect.
 */
export function fieldVerdict(rows, { threshold = 0.95, minPersons = 5, baselineArm = 'default' } = {}) {
  if (!(threshold > 0 && threshold < 1) || !Number.isInteger(minPersons) || minPersons < 1) throw new Error('field-verdict: threshold must be in (0, 1) and minPersons a positive integer');
  const cells = pairCells(rows, { baselineArm });
  const groups = groupBy(cells, (c) => ({ event: c.event, metric: c.metric, journey: c.journey, arm: c.arm }))
    .map((g) => summarize(g.key, g.cells, { threshold, minPersons })).sort(order);
  const controlMoved = groups.filter((g) => g.metric === 'file_read_ms' && g.persons >= minPersons
    && ((g.low > 1 && 1 / g.ratio < threshold) || (g.high < 1 && 1 / g.ratio > 1 / threshold)));
  return { threshold, minPersons, baselineArm, cells: cells.length, groups, regressed: groups.filter((g) => g.status === 'regressed'), controlMoved };
}

function table(groups) {
  const head = ['event', 'journey', 'metric', 'arm', 'persons', 'cells', 'ratio (99% interval)', 'speed', 'verdict'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const g of groups) {
    const interval = g.ratio === null ? 'n/a' : `${g.ratio} (${g.low}-${g.high})`;
    lines.push(`| ${[g.event, g.journey, g.metric, `\`${g.arm}\``, g.persons, g.cells, interval, g.speed ?? 'n/a', g.status].join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Markdown for the PR comment / step summary. */
export function renderMarkdown(verdict, { build } = {}) {
  const title = build ? `Field verdict for build \`${build}\`` : 'Field verdict';
  const judged = verdict.groups.filter((g) => g.status !== 'context');
  const headline = verdict.cells === 0
    ? 'No (person, model) cell has loads in both windows yet, so there is no paired ratio to report.'
    : judged.every((g) => g.status === 'insufficient')
      ? `**Insufficient paired data:** no group reached ${verdict.minPersons} paired people, so there is no verdict for this build (not a pass).`
      : verdict.regressed.length > 0
      ? `**${verdict.regressed.length} group(s) regressed** (speed below ${verdict.threshold}, 99% interval excluding 1).`
      : `No group regressed (speed threshold ${verdict.threshold}, 99% interval, at least ${verdict.minPersons} paired people).`;
  const control = verdict.controlMoved.length > 0
    ? [`**Treat load results as suspect in ${verdict.controlMoved.map((g) => g.journey).join(', ')}:** \`file_read_ms\` moved, and it barely depends on the app.`, '']
    : [];
  return [
    `### ${title}`,
    '',
    headline,
    '',
    ...control,
    `Paired ratio = median(recent) / median(baseline) per (person, model) cell, baseline window and \`${verdict.baselineArm}\` arm only; each person's median, then the median across people; speed = 1 / ratio. Method: \`scripts/perf/README.md\`, "Reading the FIELD telemetry".`,
    '',
    verdict.groups.length ? table(verdict.groups) : '_no paired cells_',
    '',
  ].join('\n');
}

/** The HogQL from README.md, with the judged build and baseline length filled in. */
export function verdictSql({ build, baselineDays = 14, readme = readFileSync(README, 'utf8') }) {
  // Events carry the 12-character `app_build_sha`; a shorter prefix would
  // match nothing (or, worse, be mistaken for a build with no traffic).
  if (!/^[0-9a-f]{12,40}$/.test(build ?? '')) throw new Error('field-verdict: --build must be a hex commit sha of at least 12 characters (the app_build_sha length)');
  if (!Number.isInteger(baselineDays) || baselineDays < 1 || baselineDays > 60) throw new Error('field-verdict: --baseline-days must be 1-60');
  const at = readme.indexOf(SQL_MARKER);
  const fence = at === -1 ? null : /```sql\n([\s\S]*?)```/.exec(readme.slice(at));
  if (!fence) throw new Error(`field-verdict: README.md has no sql block after ${SQL_MARKER}`);
  return fence[1].replaceAll('__BUILD__', build.slice(0, 12)).replaceAll('__BASELINE_DAYS__', String(baselineDays));
}

function parseArgs(argv) {
  const args = { threshold: 0.95, minPersons: 5, baselineDays: 14 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`field-verdict: ${a} needs a value`);
      return v;
    };
    if (a === '--threshold') args.threshold = Number(value());
    else if (a === '--min-persons') args.minPersons = Number(value());
    else if (a === '--baseline-days') args.baselineDays = Number(value());
    else if (a === '--build') args.build = value();
    else if (a === '--out') args.out = value();
    else if (a === '--json') args.json = true;
    else if (a === '--print-sql') args.printSql = true;
    else if (a === '--fail-on-regression') args.failOnRegression = true;
    else if (a.startsWith('--')) throw new Error(`field-verdict: unknown option ${a}`);
    else rest.push(a);
  }
  if (!(args.threshold > 0 && args.threshold < 1)) throw new Error('field-verdict: --threshold must be a number in (0, 1)');
  if (!Number.isInteger(args.minPersons) || args.minPersons < 1) throw new Error('field-verdict: --min-persons must be a positive integer');
  args.input = rest[0];
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.printSql) {
    process.stdout.write(verdictSql({ build: args.build, baselineDays: args.baselineDays }));
    return 0;
  }
  if (!args.input) throw new Error('field-verdict: pass the HogQL result JSON file (or --print-sql)');
  const verdict = fieldVerdict(parseRows(JSON.parse(readFileSync(args.input, 'utf8'))), args);
  const text = args.json ? `${JSON.stringify({ build: args.build ?? null, ...verdict }, null, 2)}\n` : renderMarkdown(verdict, args);
  if (args.out) writeFileSync(args.out, text);
  else process.stdout.write(text);
  return args.failOnRegression && verdict.regressed.length > 0 ? 2 : 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
