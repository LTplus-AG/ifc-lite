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
 * - `regression`: it gained degenerate triangles or triangles with an
 *   out-of-range index (`badIndices`), lost more than 1% of its
 *   area, or gained open or nonmanifold edges (bit-exact or at the
 *   10 um weld), or more than 1e-6 m2 of thin material or coincident sheet.
 * - `qualityWorse`: not a regression, closed no open edge, and gained slivers
 *   or raised its max aspect above 1.5x the base.
 * - `improved`: lost open edges, nonmanifold edges or thin material and is
 *   neither of the above.
 * - `neutral`: anything else that changed.
 *
 * An empty census file is refused (exit 2). Models that emitted no meshes are
 * read from the runner's `<file>.empty` sidecars: listed, and a failure when
 * base and branch disagree. A sidecar on one side only is refused (exit 2).
 *
 * Meshes present on one side only are reported as `missing` / `added`; a
 * missing mesh is a regression, and so is an added one carrying open or
 * nonmanifold edges, bad indices, degenerate triangles, or thin or coincident
 * sheet. A mesh whose thin-material census hit its
 * candidate cap on either side is `unmeasured`, never unchanged. Exit status
 * 1 when any regression, quality-worse, unmeasured or missing mesh exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const METRICS = ['tris', 'open', 'nonmanifold', 'open10', 'nonmanifold10', 'slivers', 'degenerate', 'maxAspect', 'area', 'thinArea', 'coincidentArea', 'thinCapped', 'badIndices'];
/** Thin-material area (m2) a mesh may gain or lose before it counts. */
const THIN_EPS = 1e-6;
const SHEETS = ['thinArea', 'coincidentArea'];
/** Relative surface area a mesh may lose before it counts as collapsing (a
 * removed strip of host loses well under this; #12381 loses 0.33%). */
const AREA_LOSS = 0.01;
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
// Thin and coincident area are judged by the absolute THIN_EPS both ways, so a
// large sheet growing past it can never read as relatively unchanged.
const sameMetric = (m, a, b) => (SHEETS.includes(m) ? Math.abs(a - b) <= THIN_EPS : same(a, b));

/** The verdict for one mesh present on both sides, or null when unchanged. */
export function classify(base, branch) {
  // A face that hit the candidate cap was not fully measured on that side, so
  // "no thin material" there means nothing: never read it as unchanged.
  if (base.thinCapped > 0 || branch.thinCapped > 0) return 'unmeasured';
  if (METRICS.every((m) => sameMetric(m, base[m], branch[m]))) return null;
  // Collapsed triangles drop out of the edge census, so a mesh losing its
  // geometry keeps 0 open edges: degenerate triangles and lost area catch it.
  const collapsed =
    branch.degenerate > base.degenerate ||
    branch.badIndices > base.badIndices ||
    branch.area < (1 - AREA_LOSS) * base.area;
  const gained =
    collapsed || EDGES.some((m) => branch[m] > base[m]) || SHEETS.some((m) => branch[m] > base[m] + THIN_EPS);
  if (gained) return 'regression';
  const closed = base.open10 > branch.open10 || base.open > branch.open;
  const worse = branch.slivers > base.slivers || branch.maxAspect > 1.5 * base.maxAspect;
  if (worse && !closed) return 'qualityWorse';
  const lost = EDGES.some((m) => branch[m] < base[m]) || SHEETS.some((m) => branch[m] < base[m] - THIN_EPS);
  return lost ? 'improved' : 'neutral';
}

/** Whether a mesh carries any defect the gate counts, on its own. */
export function hasDefects(row) {
  return (
    EDGES.some((m) => row[m] > 0) ||
    row.badIndices > 0 ||
    row.degenerate > 0 ||
    SHEETS.some((m) => row[m] > THIN_EPS)
  );
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
    if (baseRows.has(key)) continue;
    // A new mesh whose thin census hit its cap was not measured either, and a
    // new mesh arriving with defects is a regression with no base to excuse it.
    const verdict = branch.thinCapped > 0 ? 'unmeasured' : hasDefects(branch) ? 'regression' : 'added';
    verdicts[verdict].push({ key, branch });
  }
  return verdicts;
}

function describe({ key, base, branch }) {
  const [model, id, ord] = key.split('\t');
  const parts = METRICS.filter((m) => base && branch && !sameMetric(m, base[m], branch[m])).map(
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
  const baseRows = parseCensus(readFileSync(basePath, 'utf8'));
  const branchRows = parseCensus(readFileSync(branchPath, 'utf8'));
  // An empty census measured nothing; comparing two of them proves nothing.
  for (const [path, rows] of [[basePath, baseRows], [branchPath, branchRows]]) {
    if (rows.size === 0) {
      console.error(`${path}: no census rows, nothing was measured`);
      return 2;
    }
  }
  const verdicts = compare(baseRows, branchRows);
  // Models that emitted no meshes have no rows to compare, so the runner lists
  // them beside the output (<out>.empty). Show them, and fail when the two
  // sides disagree: a model empty on one side only lost or gained everything.
  const [baseEmpty, branchEmpty] = [basePath, branchPath].map((p) =>
    existsSync(`${p}.empty`) ? readFileSync(`${p}.empty`, 'utf8').split('\n').filter(Boolean).sort() : null,
  );
  // Both sides or neither: a sidecar on one side only would let a model that
  // was empty on one side and not the other pass unseen.
  if (Boolean(baseEmpty) !== Boolean(branchEmpty)) {
    console.error(`${baseEmpty ? branchPath : basePath}.empty is missing; run both sides with mesh-census-corpus.sh`);
    return 2;
  }
  const emptyDiffers = baseEmpty && branchEmpty && baseEmpty.join('\n') !== branchEmpty.join('\n');
  if (argv.includes('--json')) {
    console.log(JSON.stringify(verdicts, null, 2));
  } else {
    for (const [name, list] of Object.entries(verdicts)) {
      console.log(`${name}: ${list.length}`);
      for (const entry of list.slice(0, 50)) console.log(`  ${entry.branch && entry.base ? describe(entry) : entry.key}`);
      if (list.length > 50) console.log(`  ... ${list.length - 50} more`);
    }
  }
  if (baseEmpty || branchEmpty) {
    console.log(`models with no meshes: base ${baseEmpty?.length ?? '?'}, branch ${branchEmpty?.length ?? '?'}${emptyDiffers ? ' (DIFFERENT)' : ''}`);
    for (const m of branchEmpty ?? baseEmpty) console.log(`  ${m}`);
  }
  const failing = ['regression', 'qualityWorse', 'unmeasured', 'missing'];
  return emptyDiffers || failing.some((v) => verdicts[v].length > 0) ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
