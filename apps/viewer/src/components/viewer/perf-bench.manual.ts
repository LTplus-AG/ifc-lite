/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual (not CI) benchmark for the streaming quadratic-rescan fix in
 * `robustFitBoundsAccumulator`.
 * Run with: npx tsx src/components/viewer/perf-bench.manual.ts
 *
 * Simulates a streaming load at several total mesh counts, replaying the
 * SAME commit/batch pattern against:
 *   - the OLD full-rescan algorithm (robustFitBoundsFull), called with the
 *     ENTIRE accumulated meshes array on every commit — what
 *     useGeometryStreaming's early-fit branch did before the fix, in the
 *     documented worst case where cameraFittedRef never latches.
 *   - the NEW incremental accumulator, called the same way.
 *
 * A second arm used to bench StatusBar's element count the same way. That
 * count is gone: the status bar no longer derives "N elements" from the mesh
 * array at all, it counts physical objects off the entity index
 * (`lib/object-count.ts`), so there is no per-commit mesh rescan left to
 * optimise there.
 *
 * Not a *.test.ts — deliberately excluded from `pnpm test` (perf numbers on
 * a shared CI runner are not a regression gate here); this file exists only
 * to reproduce the before/after scaling numbers reported alongside the fix.
 */

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

function makeMesh(rng: () => number): RobustFitMeshInput {
  const vcount = 80 + Math.floor(rng() * 240); // ~80-320 verts/mesh, closer to real element meshes
  const positions = new Float32Array(vcount * 3);
  const cx = rng() * 50, cy = rng() * 50, cz = rng() * 50;
  for (let v = 0; v < vcount; v++) {
    positions[v * 3] = cx + (rng() - 0.5) * 2;
    positions[v * 3 + 1] = cy + (rng() - 0.5) * 2;
    positions[v * 3 + 2] = cz + (rng() - 0.5) * 2;
  }
  return { positions };
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

type RunResult = { fitMs: number; wallMs: number };

function runFull(allMeshes: RobustFitMeshInput[], batches: number[]): RunResult {
  const meshArray: RobustFitMeshInput[] = [];
  let idx = 0;
  const t0 = performance.now();
  let fitMs = 0;
  for (const b of batches) {
    for (let k = 0; k < b; k++) {
      meshArray.push(allMeshes[idx]);
      idx++;
    }
    const f0 = performance.now();
    robustFitBoundsFull(meshArray);
    fitMs += performance.now() - f0;
  }
  return { fitMs, wallMs: performance.now() - t0 };
}

function runIncremental(allMeshes: RobustFitMeshInput[], batches: number[]): RunResult {
  const meshArray: RobustFitMeshInput[] = [];
  const fitAcc = createRobustFitBoundsAccumulator();
  let idx = 0;
  const t0 = performance.now();
  let fitMs = 0;
  for (const b of batches) {
    for (let k = 0; k < b; k++) {
      meshArray.push(allMeshes[idx]);
      idx++;
    }
    const f0 = performance.now();
    fitAcc.update(meshArray);
    fitMs += performance.now() - f0;
  }
  return { fitMs, wallMs: performance.now() - t0 };
}

const avg = (a: RunResult, b: RunResult): RunResult => ({
  fitMs: (a.fitMs + b.fitMs) / 2,
  wallMs: (a.wallMs + b.wallMs) / 2,
});

function bench(totalMeshes: number, targetCommits: number, seed: number) {
  const rng = mulberry32(seed);
  const allMeshes: RobustFitMeshInput[] = [];
  for (let i = 0; i < totalMeshes; i++) allMeshes.push(makeMesh(rng));
  const batches = commitPlan(totalMeshes, targetCommits);

  // Each algorithm is run twice per size, in BOTH relative orders (full-then-
  // incremental and incremental-then-full), and the two runs are averaged.
  // Running one algorithm right after the other consistently within a
  // process hands whichever runs SECOND a JIT/inline-cache warm-up
  // advantage from the first run's shared subroutines (array push, Math.*,
  // etc.) — averaging both orders cancels that directional bias out.
  // Execution order: full(1st), incremental(2nd), incremental(3rd), full(4th).
  // Averaging each algorithm's two runs gives both a mean execution
  // position of 2.5 (full: (1+4)/2, incremental: (2+3)/2) — symmetric, so
  // neither consistently benefits from running immediately after the other.
  const fullRunA = runFull(allMeshes, batches);
  const incRunA = runIncremental(allMeshes, batches);
  const incRunB = runIncremental(allMeshes, batches);
  const fullRunB = runFull(allMeshes, batches);
  const before = avg(fullRunA, fullRunB);
  const after = avg(incRunA, incRunB);

  console.log(
    `meshes ${String(totalMeshes).padStart(6)}  commits ${String(batches.length).padStart(3)}  ` +
    `BEFORE robustFitBounds ${before.fitMs.toFixed(1).padStart(7)}ms  wall ${before.wallMs.toFixed(1)}ms  |  ` +
    `AFTER robustFitBounds ${after.fitMs.toFixed(1).padStart(7)}ms  wall ${after.wallMs.toFixed(1)}ms`,
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
