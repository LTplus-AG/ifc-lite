/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge planning benchmark — the 05-merge §5.7 budget scenario:
 * two 50k-op layers over a 1M-entity model, plan < 1s.
 *
 *   pnpm --filter @ifc-lite/merge bench       (requires `pnpm build` first)
 *
 * Results are recorded in docs/architecture/layer-prs/05-merge.md §5.7 —
 * re-run and update the table when the planner changes. Deliberately a
 * script, not a CI job: a 1M-entity in-memory model costs ~2 GB heap and
 * minutes of runner time per commit for a number that only moves when
 * the planner does (AGENTS.md: prefer on-demand tooling over CI cost).
 */

import { planThreeWayMerge } from '../dist/index.js';

const CLASS = 'bsi::ifc::class';
const MARKER = 'bsi::ifc::v5a::Pset_Bench::Marker';

function layer(data, id) {
  return {
    header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 'bench', timestamp: '2026-06-10T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
}

function buildBase(entityCount) {
  const data = new Array(entityCount);
  for (let i = 0; i < entityCount; i++) {
    data[i] = {
      path: `entity-${i}`,
      attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [MARKER]: 'BASE' },
    };
  }
  return layer(data, 'base');
}

/** Deterministic LCG — reproducible op sites across runs/machines. */
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function buildEdits(entityCount, opCount, tag, seed) {
  const rand = lcg(seed);
  const data = new Array(opCount);
  for (let i = 0; i < opCount; i++) {
    const target = Math.floor(rand() * entityCount);
    data[i] = { path: `entity-${target}`, attributes: { [MARKER]: `${tag}-${i}` } };
  }
  return layer(data, tag);
}

function bench(entityCount, opCount, runs = 3) {
  const base = buildBase(entityCount);
  const ours = [base, buildEdits(entityCount, opCount, 'ours', 1)];
  const theirs = [base, buildEdits(entityCount, opCount, 'theirs', 2)];
  const times = [];
  let plan;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    plan = planThreeWayMerge({ ancestor: [base], ours, theirs });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { entityCount, opCount, median: times[Math.floor(runs / 2)], times, plan };
}

const scales = [
  { entities: 10_000, ops: 1_000 },
  { entities: 100_000, ops: 10_000 },
  { entities: 1_000_000, ops: 50_000 },
];

console.log('three-way plan benchmark (median of 3, full re-plan incl. state extraction)\n');
console.log('entities   ops/side   median      runs                         auto/conflicts');
for (const { entities, ops } of scales) {
  const r = bench(entities, ops);
  const runs = r.times.map((t) => `${t.toFixed(0)}ms`).join(' ');
  console.log(
    `${String(entities).padStart(9)}  ${String(ops).padStart(8)}  ${`${r.median.toFixed(0)}ms`.padStart(8)}   ${runs.padEnd(28)} ${r.plan.autoOps.length}/${r.plan.conflicts.length}`
  );
}
console.log('\nbudget (05 §5.7): two 50k-op layers over 1M entities < 1s');
