/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual (not CI) benchmark for the two streaming quadratic-rescan fixes.
 * Run with: npx tsx src/components/viewer/perf-bench.manual.ts
 *
 * Simulates a streaming load at several total mesh counts, replaying the
 * SAME commit/batch pattern against:
 *   - the OLD full-rescan algorithm (computeStatsFull / robustFitBoundsFull),
 *     called with the ENTIRE accumulated meshes array on every commit — this
 *     is what StatusBar's memo and useGeometryStreaming's early-fit branch
 *     did before the fix, since `geometryResult` is a new object every
 *     commit (so the memo never hit) and, for robustFitBounds, the
 *     documented worst case where cameraFittedRef never latches.
 *   - the NEW incremental accumulator, called the same way.
 *
 * Not a *.test.ts — deliberately excluded from `pnpm test` (perf numbers on
 * a shared CI runner are not a regression gate here); this file exists only
 * to reproduce the before/after scaling numbers reported alongside the fix.
 */

import { computeStatsFull, createStatusBarStatsAccumulator, type StatusBarGeometryResult } from './statusBarStats.js';
import { robustFitBoundsFull, createRobustFitBoundsAccumulator, type RobustFitMeshInput } from './robustFitBoundsAccumulator.js';

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeMesh(rng: () => number, i: number): { entityIds?: Uint32Array } & RobustFitMeshInput {
  const vcount = 80 + Math.floor(rng() * 240); // ~80-320 verts/mesh, closer to real element meshes
  const positions = new Float32Array(vcount * 3);
  const cx = rng() * 50, cy = rng() * 50, cz = rng() * 50;
  for (let v = 0; v < vcount; v++) {
    positions[v * 3] = cx + (rng() - 0.5) * 2;
    positions[v * 3 + 1] = cy + (rng() - 0.5) * 2;
    positions[v * 3 + 2] = cz + (rng() - 0.5) * 2;
  }
  const idCount = 1 + Math.floor(rng() * 3);
  const entityIds = new Uint32Array(idCount);
  for (let k = 0; k < idCount; k++) entityIds[k] = i * 4 + k;
  return { positions, entityIds };
}

function commitPlan(totalMeshes: number, commitCount: number): number[] {
  // Even split into exactly `commitCount` batches, matching the task's
  // measured commit counts at each size (2K→4, 4K→7, 8K→14, 16.7K→30).
  const batches: number[] = [];
  let remaining = totalMeshes;
  for (let c = 0; c < commitCount; c++) {
    const left = commitCount - c;
    const n = Math.ceil(remaining / left);
    batches.push(n);
    remaining -= n;
  }
  return batches;
}

function bench(totalMeshes: number, targetCommits: number, seed: number) {
  const rng = mulberry32(seed);
  const allMeshes: (({ entityIds?: Uint32Array }) & RobustFitMeshInput)[] = [];
  for (let i = 0; i < totalMeshes; i++) allMeshes.push(makeMesh(rng, i));
  const batches = commitPlan(totalMeshes, targetCommits);

  // ── BEFORE: full rescan every commit ──
  const geomArrayFull: (({ entityIds?: Uint32Array }))[] = [];
  const meshArrayFull: RobustFitMeshInput[] = [];
  let idx = 0;
  const t0 = performance.now();
  let statsFullTotalMs = 0;
  let fitFullTotalMs = 0;
  for (const b of batches) {
    for (let k = 0; k < b; k++) {
      geomArrayFull.push(allMeshes[idx]);
      meshArrayFull.push(allMeshes[idx]);
      idx++;
    }
    const gr: StatusBarGeometryResult = { meshes: geomArrayFull, totalTriangles: geomArrayFull.length * 2 };
    const s0 = performance.now();
    computeStatsFull(gr);
    statsFullTotalMs += performance.now() - s0;

    const f0 = performance.now();
    robustFitBoundsFull(meshArrayFull);
    fitFullTotalMs += performance.now() - f0;
  }
  const beforeWallMs = performance.now() - t0;

  // ── AFTER: incremental accumulator every commit ──
  const geomArrayInc: (({ entityIds?: Uint32Array }))[] = [];
  const meshArrayInc: RobustFitMeshInput[] = [];
  const statsAcc = createStatusBarStatsAccumulator();
  const fitAcc = createRobustFitBoundsAccumulator();
  idx = 0;
  const t1 = performance.now();
  let statsIncTotalMs = 0;
  let fitIncTotalMs = 0;
  for (const b of batches) {
    for (let k = 0; k < b; k++) {
      geomArrayInc.push(allMeshes[idx]);
      meshArrayInc.push(allMeshes[idx]);
      idx++;
    }
    const gr: StatusBarGeometryResult = { meshes: geomArrayInc, totalTriangles: geomArrayInc.length * 2 };
    const s0 = performance.now();
    statsAcc.update(gr);
    statsIncTotalMs += performance.now() - s0;

    const f0 = performance.now();
    fitAcc.update(meshArrayInc);
    fitIncTotalMs += performance.now() - f0;
  }
  const afterWallMs = performance.now() - t1;

  console.log(
    `meshes ${String(totalMeshes).padStart(6)}  commits ${String(batches.length).padStart(3)}  ` +
    `BEFORE robustFitBounds ${fitFullTotalMs.toFixed(1).padStart(7)}ms  StatusBar.stats ${statsFullTotalMs.toFixed(1).padStart(7)}ms  wall ${beforeWallMs.toFixed(1)}ms  |  ` +
    `AFTER robustFitBounds ${fitIncTotalMs.toFixed(1).padStart(7)}ms  StatusBar.stats ${statsIncTotalMs.toFixed(1).padStart(7)}ms  wall ${afterWallMs.toFixed(1)}ms`,
  );
}

console.log('Simulated streaming load — full rescan (BEFORE) vs incremental accumulator (AFTER)\n');
const sizesAndCommits: Array<[number, number]> = [
  [2000, 4],
  [4000, 7],
  [8000, 14],
  [16700, 30],
  [33400, 60],
];
for (const [size, commits] of sizesAndCommits) {
  bench(size, commits, size);
}
