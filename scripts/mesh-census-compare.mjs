#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-mesh no-worse rule over two `mesh_census` outputs (#8190).
 *
 * Usage: node scripts/mesh-census-compare.mjs <base.jsonl> <branch.jsonl> [--json]
 *
 * The verdict is per mesh, never in aggregate: a net improvement across the
 * corpus does not buy a single worse mesh. A mesh is keyed by model, express
 * id and its ordinal among that id's meshes. For a CHANGED mesh:
 *
 * - `regression`: it gained open or nonmanifold edges (bit-exact or at the
 *   10 um weld), or more than 1e-6 m2 of thin material or coincident sheet.
 * - `qualityWorse`: not a regression, closed no open edge, and gained slivers
 *   or raised its max aspect above 1.5x the base.
 * - `improved`: lost open edges, nonmanifold edges or thin material and is
 *   neither of the above.
 * - `neutral`: anything else that changed.
 *
 * Meshes present on one side only are reported as `missing` / `added`; a
 * missing mesh is a regression. A mesh whose thin-material census hit its
 * candidate cap on either side is `unmeasured`, never unchanged. Exit status
 * 1 when any regression, quality-worse, unmeasured or missing mesh exists.
 */

import { readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const METRICS = ['tris', 'open', 'nonmanifold', 'open10', 'nonmanifold10', 'slivers', 'degenerate', 'maxAspect', 'area', 'thinArea', 'coincidentArea', 'thinCapped'];
/** Thin-material area (m2) a mesh may gain or lose before it counts. */
const THIN_EPS = 1e-6;
const SHEETS = ['thinArea', 'coincidentArea'];
const EDGES = ['open', 'nonmanifold', 'open10', 'nonmanifold10'];

export function parseCensus(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const key = `${row.model}\t${row.id}\t${row.ord}`;
    const bad = METRICS.filter((m) => typeof row[m] !== 'number' || !Number.isFinite(row[m]));
    if (bad.length) throw new Error(`census row ${key}: missing or invalid ${bad.join(', ')}`);
    if (rows.has(key)) throw new Error(`census row ${key} appears twice`);
    rows.set(key, row);
  }
  return rows;
}

/** Float metrics within this relative distance are the same number. */
const REL_EPS = 1e-9;
const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= REL_EPS * Math.max(Math.abs(a), Math.abs(b)));

/** The verdict for one mesh present on both sides, or null when unchanged. */
export function classify(base, branch) {
  // A face that hit the candidate cap was not fully measured on that side, so
  // "no thin material" there means nothing: never read it as unchanged.
  if (base.thinCapped > 0 || branch.thinCapped > 0) return 'unmeasured';
  if (METRICS.every((m) => same(base[m], branch[m]))) return null;
  const gained = EDGES.some((m) => branch[m] > base[m]) || SHEETS.some((m) => branch[m] > base[m] + THIN_EPS);
  if (gained) return 'regression';
  const closed = base.open10 > branch.open10 || base.open > branch.open;
  const worse = branch.slivers > base.slivers || branch.maxAspect > 1.5 * base.maxAspect;
  if (worse && !closed) return 'qualityWorse';
  const lost = EDGES.some((m) => branch[m] < base[m]) || SHEETS.some((m) => branch[m] < base[m] - THIN_EPS);
  return lost ? 'improved' : 'neutral';
}

export function compare(baseRows, branchRows) {
  const verdicts = { regression: [], qualityWorse: [], unmeasured: [], improved: [], neutral: [], missing: [], added: [] };
  for (const [key, base] of baseRows) {
    const branch = branchRows.get(key);
    if (!branch) {
      verdicts.missing.push({ key, base });
      continue;
    }
    const verdict = classify(base, branch);
    if (verdict) verdicts[verdict].push({ key, base, branch });
  }
  for (const [key, branch] of branchRows) {
    if (!baseRows.has(key)) verdicts.added.push({ key, branch });
  }
  return verdicts;
}

function describe({ key, base, branch }) {
  const [model, id, ord] = key.split('\t');
  const parts = METRICS.filter((m) => base && branch && !same(base[m], branch[m])).map(
    (m) => `${m} ${fmt(base[m])}->${fmt(branch[m])}`,
  );
  return `${model} #${id}[${ord}] ${(base ?? branch).type}: ${parts.join(', ')}`;
}

const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(7)) : v);

function main(argv) {
  const [basePath, branchPath] = argv.filter((a) => !a.startsWith('--'));
  if (!basePath || !branchPath) {
    console.error('usage: mesh-census-compare.mjs <base.jsonl> <branch.jsonl> [--json]');
    return 2;
  }
  const verdicts = compare(parseCensus(readFileSync(basePath, 'utf8')), parseCensus(readFileSync(branchPath, 'utf8')));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(verdicts, null, 2));
  } else {
    for (const [name, list] of Object.entries(verdicts)) {
      console.log(`${name}: ${list.length}`);
      for (const entry of list.slice(0, 50)) console.log(`  ${entry.branch && entry.base ? describe(entry) : entry.key}`);
      if (list.length > 50) console.log(`  ... ${list.length - 50} more`);
    }
  }
  const failing = ['regression', 'qualityWorse', 'unmeasured', 'missing'];
  return failing.some((v) => verdicts[v].length > 0) ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
