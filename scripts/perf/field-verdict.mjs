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
 * out by construction (see "Reading the FIELD telemetry" in README.md). A
 * group's pooled ratio is the median of its cell ratios; above 1 is slower.
 *
 * The verdict's threshold is on SPEED, 1 / ratio: a pooled speed below 0.95
 * (5% slower) is a regression. A group with fewer paired cells than
 * `--min-cells` is `insufficient`: its ratio is not small, it is undefined.
 *
 * Input is the result of the HogQL in README.md (marker
 * `field-verdict-hogql`), as the PostHog query API returns it
 * (`{ columns, results }`), or an array of row objects. Offline by design:
 * the fetch lives in `field-verdict-fetch.mjs` and the workflow.
 *
 *   node scripts/perf/field-verdict.mjs result.json [--threshold 0.95] [--min-cells 5]
 *        [--build <sha>] [--json] [--fail-on-regression]
 *   node scripts/perf/field-verdict.mjs --print-sql --build <12-char sha> [--baseline-days 14]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

function summarize(key, cells, { threshold, minCells }) {
  const ratios = cells.map((c) => c.ratio).sort((a, b) => a - b);
  const ratio = quantile(ratios, 0.5);
  const speed = 1 / ratio;
  let status;
  if (cells.length < minCells) status = 'insufficient';
  else if (speed < threshold) status = 'regressed';
  else if (speed > 1 / threshold) status = 'improved';
  else status = 'flat';
  return {
    ...key,
    cells: cells.length,
    persons: new Set(cells.map((c) => c.person)).size,
    loads: cells.reduce((sum, c) => sum + c.recentN + c.baselineN, 0),
    ratio: round(ratio),
    p25: round(quantile(ratios, 0.25)),
    p75: round(quantile(ratios, 0.75)),
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
const order = (a, b) => byText(a.event, b.event) || byText(a.metric, b.metric) || byText(a.journey ?? '', b.journey ?? '') || byText(a.arm, b.arm);

/**
 * The verdict: per (event, metric, journey, arm) and pooled across journeys per
 * (event, metric, arm). `regressed` lists the pooled groups whose speed fell
 * below the threshold with enough cells to say so.
 */
export function fieldVerdict(rows, { threshold = 0.95, minCells = 5, baselineArm = 'default' } = {}) {
  const cells = pairCells(rows, { baselineArm });
  const opts = { threshold, minCells };
  const perJourney = groupBy(cells, (c) => ({ event: c.event, metric: c.metric, journey: c.journey, arm: c.arm }))
    .map((g) => summarize(g.key, g.cells, opts)).sort(order);
  const pooled = groupBy(cells, (c) => ({ event: c.event, metric: c.metric, arm: c.arm }))
    .map((g) => summarize(g.key, g.cells, opts)).sort(order);
  return { threshold, minCells, baselineArm, cells: cells.length, perJourney, pooled, regressed: pooled.filter((g) => g.status === 'regressed') };
}

function table(groups, withJourney) {
  const head = ['event', 'metric', ...(withJourney ? ['journey'] : []), 'arm', 'cells', 'persons', 'ratio (IQR)', 'speed', 'verdict'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const g of groups) {
    const iqr = g.ratio === null ? 'n/a' : `${g.ratio} (${g.p25}-${g.p75})`;
    lines.push(`| ${[g.event, g.metric, ...(withJourney ? [g.journey] : []), `\`${g.arm}\``, g.cells, g.persons, iqr, g.speed ?? 'n/a', g.status].join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Markdown for the PR comment / step summary. */
export function renderMarkdown(verdict, { build } = {}) {
  const title = build ? `Field verdict for build \`${build}\`` : 'Field verdict';
  const headline = verdict.cells === 0
    ? 'No (person, model) cell has loads in both windows yet, so there is no paired ratio to report.'
    : verdict.regressed.length > 0
      ? `**${verdict.regressed.length} pooled group(s) regressed** (speed below ${verdict.threshold}).`
      : `No pooled group regressed (speed threshold ${verdict.threshold}, at least ${verdict.minCells} paired cells).`;
  return [
    `### ${title}`,
    '',
    headline,
    '',
    `Paired ratio = median(recent) / median(baseline) per (person, model) cell, baseline window and \`${verdict.baselineArm}\` arm only; pooled = median over cells; speed = 1 / ratio. Method: \`scripts/perf/README.md\`, "Reading the FIELD telemetry".`,
    '',
    '#### Pooled across journeys',
    '',
    verdict.pooled.length ? table(verdict.pooled, false) : '_no paired cells_',
    '',
    '<details><summary>Per journey</summary>',
    '',
    verdict.perJourney.length ? table(verdict.perJourney, true) : '_no paired cells_',
    '',
    '</details>',
    '',
  ].join('\n');
}

/** The HogQL from README.md, with the judged build and baseline length filled in. */
export function verdictSql({ build, baselineDays = 14, readme = readFileSync(README, 'utf8') }) {
  if (!/^[0-9a-f]{7,40}$/.test(build ?? '')) throw new Error('field-verdict: --build must be a hex commit sha');
  if (!Number.isInteger(baselineDays) || baselineDays < 1 || baselineDays > 60) throw new Error('field-verdict: --baseline-days must be 1-60');
  const at = readme.indexOf(SQL_MARKER);
  const fence = at === -1 ? null : /```sql\n([\s\S]*?)```/.exec(readme.slice(at));
  if (!fence) throw new Error(`field-verdict: README.md has no sql block after ${SQL_MARKER}`);
  return fence[1].replaceAll('__BUILD__', build.slice(0, 12)).replaceAll('__BASELINE_DAYS__', String(baselineDays));
}

function parseArgs(argv) {
  const args = { threshold: 0.95, minCells: 5, baselineDays: 14 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`field-verdict: ${a} needs a value`);
      return v;
    };
    if (a === '--threshold') args.threshold = Number(value());
    else if (a === '--min-cells') args.minCells = Number(value());
    else if (a === '--baseline-days') args.baselineDays = Number(value());
    else if (a === '--build') args.build = value();
    else if (a === '--out') args.out = value();
    else if (a === '--json') args.json = true;
    else if (a === '--print-sql') args.printSql = true;
    else if (a === '--fail-on-regression') args.failOnRegression = true;
    else if (a.startsWith('--')) throw new Error(`field-verdict: unknown option ${a}`);
    else rest.push(a);
  }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
