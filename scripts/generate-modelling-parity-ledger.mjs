#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `docs/architecture/modelling-parity-ledger.md`: the modelling
 * parity scorecard of #9296, one row per capability in
 * `tests/modelling-parity/catalogue.json`, one column per probe level, with
 * the status measured by the probes, never a hand-typed opinion.
 *
 * DERIVATION. Rows, groups, titles and which levels apply come from the
 * catalogue. Statuses, reasons and the score come from a scorecard summary
 * (`ifclite-parity-summary/1`, written by `tests/modelling-parity/score.mjs`).
 * By default that is the summary with the newest `generatedAt` under
 * `tests/modelling-parity/baseline/`; `--summary <file>` picks another.
 *
 * VACUITY GUARD: an empty catalogue, a summary with no rows, a summary row the
 * catalogue does not know, or a table-stakes row the summary lacks is an
 * error, never a ledger that silently reads "0 / 0".
 *
 * Usage:
 *   node scripts/generate-modelling-parity-ledger.mjs             # regenerate + write
 *   node scripts/generate-modelling-parity-ledger.mjs --check     # fail if the committed ledger is stale
 *   node scripts/generate-modelling-parity-ledger.mjs --summary tests/modelling-parity/.out/summary.json
 *   --root <dir> points every read (catalogue, baseline directory, a relative --summary) and the
 *   write at another tree (used by the test).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const flag = (name) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : null; };
const ROOT = flag('--root') ? resolve(flag('--root')) : join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const OUT_REL = 'docs/architecture/modelling-parity-ledger.md';
const CATALOGUE_REL = 'tests/modelling-parity/catalogue.json';
const BASELINE_REL = 'tests/modelling-parity/baseline';
const LEVELS = ['sdk', 'ui', 'output'];
const ICON = { pass: '✅', partial: '◐', fail: '❌', error: '❌' };
const ROW_ICON = { met: '✅ met', partial: '◐ partial', missing: '❌ missing' };

function fail(message) {
  console.error(`modelling-parity-ledger: ${message}`);
  process.exit(1);
}

function readJson(path) {
  if (!existsSync(path)) fail(`missing ${relative(ROOT, path)}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return fail(`${relative(ROOT, path)} is not JSON: ${e.message}`); }
}

function latestSummary() {
  const dir = join(ROOT, BASELINE_REL);
  if (!existsSync(dir)) fail(`no ${BASELINE_REL}/ directory with a scorecard summary`);
  const summaries = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, s: readJson(join(dir, f)) }))
    .filter(({ s }) => s.schema === 'ifclite-parity-summary/1');
  if (!summaries.length) fail(`no ifclite-parity-summary/1 file in ${BASELINE_REL}/`);
  summaries.sort((a, b) => String(b.s.generatedAt).localeCompare(String(a.s.generatedAt)) || b.f.localeCompare(a.f));
  return { path: `${BASELINE_REL}/${summaries[0].f}`, summary: summaries[0].s };
}

const catalogue = readJson(join(ROOT, CATALOGUE_REL));
const { path: summaryPath, summary } = flag('--summary')
  ? { path: relative(ROOT, resolve(ROOT, flag('--summary'))).split('\\').join('/'), summary: readJson(resolve(ROOT, flag('--summary'))) }
  : latestSummary();

if (!Array.isArray(catalogue.capabilities) || catalogue.capabilities.length === 0) fail('the catalogue lists no capabilities');
if (summary.schema !== 'ifclite-parity-summary/1') fail(`${summaryPath} is not an ifclite-parity-summary/1 file`);
if (!Array.isArray(summary.rows) || summary.rows.length === 0) fail(`${summaryPath} has no rows; refusing to render an empty scorecard`);
const known = new Set(catalogue.capabilities.map((c) => c.id));
const strays = summary.rows.filter((r) => !known.has(r.capability)).map((r) => r.capability);
if (strays.length) fail(`${summaryPath} has rows the catalogue does not know: ${strays.join(', ')}`);
const rowById = new Map(summary.rows.map((r) => [r.capability, r]));
const absent = catalogue.capabilities.filter((c) => c.tableStakes && !rowById.has(c.id)).map((c) => c.id);
if (absent.length) fail(`${summaryPath} lacks table-stakes rows: ${absent.join(', ')}; re-run tests/modelling-parity/score.mjs`);

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (text, n = 320) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function levelIcon(level) {
  if (!level || level.applicable === false) return '–';
  return ICON[level.status] ?? '–';
}

function notes(cap, row) {
  const parts = [];
  for (const l of [...LEVELS, 'exercise']) {
    const level = row?.levels?.[l];
    if (l !== 'exercise' && cap.probes?.[l]?.applicable === false) continue;
    if (!level || level.status === 'none') { if (l !== 'exercise') parts.push(`**${l}** not run yet`); continue; }
    if (level.status === 'pass') continue;
    parts.push(`**${l}** ${level.status}: ${clip(level.reason ?? 'no reason given')}`);
  }
  return parts.length ? cell(parts.join('<br>')) : '';
}

function render() {
  const stakes = catalogue.capabilities.filter((c) => c.tableStakes);
  const extra = catalogue.capabilities.filter((c) => !c.tableStakes);
  const c = summary.counts ?? { met: 0, partial: 0, missing: 0 };
  const commits = (summary.sources ?? []).map((s) => `\`${String(s.commit).slice(0, 10)}\`${s.dirty ? ' (dirty)' : ''}`).join(', ') || 'unknown';
  const lines = [];
  lines.push('# Modelling parity ledger');
  lines.push('');
  lines.push('<!-- GENERATED by scripts/generate-modelling-parity-ledger.mjs — do not edit by hand. Regenerate with `node scripts/generate-modelling-parity-ledger.mjs`; its test fails when this file is stale. -->');
  lines.push('');
  lines.push('The scorecard of the modelling parity hill climb ([#9296](https://github.com/LTplus-AG/ifc-lite/issues/9296)): the capabilities an architect treats as table stakes in Revit, Archicad, Vectorworks and Bonsai, each measured by three probes. Rows, oracles and owners live in `tests/modelling-parity/catalogue.json`; statuses come from the probes\' result files, scored by `tests/modelling-parity/score.mjs`.');
  lines.push('');
  lines.push(`**Table-stakes score: ${summary.score} / ${summary.maxScore}** (met ${c.met}, partial ${c.partial}, missing ${c.missing}). A met row counts 1, a partial row 0.5. The score may only go up: \`node tests/modelling-parity/score.mjs <dirs> --check ${summaryPath}\` fails when it or any row drops.`);
  lines.push('');
  lines.push(`Summary: \`${summaryPath}\`, generated ${summary.generatedAt} from ${summary.results} results on ${commits}; inputs ${(summary.inputs ?? []).map((i) => `\`${i}\``).join(', ') || 'not recorded'}.`);
  lines.push('');
  lines.push('Levels:');
  lines.push('');
  lines.push('- **SDK**: a headless script on a blank model through `bim.store` / `@ifc-lite/create`, checked against a geometry or data oracle read back from the exported, meshed IFC (`tests/modelling-parity/probes/sdk/`).');
  lines.push('- **UI**: the same capability in the Model workspace on the real GPU via `ifc-gpu-check` (`tests/modelling-parity/ui/`).');
  lines.push('- **Output**: the SDK probe\'s IFC4 export, and any IFC a UI result hands over, through `ifc-lite validate`, a reopen round trip and IfcOpenShell validate with express rules (`tests/modelling-parity/output/`). Drawing files a UI result hands over (SVG, PDF, DXF, for the documentation rows) get a **sanity check only**: they parse, are not empty and carry linework or pages. That is not a check that the drawing is correct.');
  lines.push('- **Exercise**: the best result of the F1–F6 exercises that exercise the row (reported, not scored).');
  lines.push('');
  lines.push('✅ pass · ◐ partial · ❌ fail or error · – skipped, not run, or not applicable. A row is **met** when every applicable level passes, **partial** when any level passes or partly passes, **missing** otherwise; `skip` never counts as a pass.');
  lines.push('');
  lines.push('## Table stakes');
  lines.push('');
  lines.push('| Capability | Group | SDK | UI | Output | Exercise | Row | Why not met |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const cap of stakes) {
    const row = rowById.get(cap.id);
    lines.push(`| ${cell(cap.title)} (\`${cap.id}\`) | ${cell(cap.group)} | ${LEVELS.map((l) => levelIcon(row.levels[l])).join(' | ')} | ${levelIcon(row.levels.exercise)} | ${ROW_ICON[row.status]} | ${row.status === 'met' ? '' : notes(cap, row)} |`);
  }
  lines.push('');
  if (extra.length) {
    lines.push('## Beyond table stakes (reported, not scored)');
    lines.push('');
    lines.push('| Capability | Group | SDK | UI | Output | Row |');
    lines.push('|---|---|---|---|---|---|');
    for (const cap of extra) {
      const row = rowById.get(cap.id);
      lines.push(`| ${cell(cap.title)} (\`${cap.id}\`) | ${cell(cap.group)} | ${LEVELS.map((l) => levelIcon(row?.levels?.[l])).join(' | ')} | ${row ? ROW_ICON[row.status] : '– not scored'} |`);
    }
    lines.push('');
  }
  lines.push('## Regenerating');
  lines.push('');
  lines.push('```bash');
  lines.push('node tests/modelling-parity/probes/sdk/run.mjs     # SDK probes -> tests/modelling-parity/.out/L1/sdk');
  lines.push('node tests/modelling-parity/output/run.mjs         # output probes -> tests/modelling-parity/.out/L1/output');
  lines.push('node tests/modelling-parity/score.mjs              # score every lane under tests/modelling-parity/.out');
  lines.push('node tests/modelling-parity/score.mjs <dirs> --out tests/modelling-parity/baseline/<round>.json');
  lines.push('node scripts/generate-modelling-parity-ledger.mjs  # this file, from the newest baseline summary');
  lines.push('```');
  return lines.join('\n') + '\n';
}

const content = render();
const target = join(ROOT, OUT_REL);
if (CHECK) {
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (existing !== content) {
    console.error(`❌ ${OUT_REL} is stale against ${summaryPath}.`);
    console.error('   fix: node scripts/generate-modelling-parity-ledger.mjs   (then commit the file)');
    process.exit(1);
  }
  console.log(`✅ ${OUT_REL} is up to date (${summary.score} / ${summary.maxScore}).`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`Wrote ${OUT_REL} from ${summaryPath}: ${summary.score} / ${summary.maxScore}`);
}
