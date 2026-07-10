/* Micro-benchmark: adapter (Plato-backed) vs hand-written originals.
 * Benches signedGap + intersects + triTriIntersect, 200k iterations each,
 * reports the adapter/original time ratio. */

import type { Vec3, AABB } from './types.js';
import * as ADP from './adapter.js';
import * as OB from './original/aabb.js';
import { triTriIntersect as origTri } from './original/triangle-intersect.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0xbeef);
const coord = () => rng() * 200 - 100;
const vec = (): Vec3 => [coord(), coord(), coord()];
const box = (): AABB => {
  const p = vec();
  const q = vec();
  return {
    min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])],
    max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])],
  };
};

const ITERS = 200000;
// pre-generate a modest pool of inputs (indexed round-robin)
const POOL = 512;
const boxesA: AABB[] = [];
const boxesB: AABB[] = [];
const tris: Vec3[][] = [];
for (let i = 0; i < POOL; i++) {
  boxesA.push(box());
  boxesB.push(box());
  tris.push([vec(), vec(), vec(), vec(), vec(), vec()]);
}

function benchSignedGap(fn: (a: AABB, b: AABB) => number): number {
  let acc = 0;
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    const a = boxesA[i & (POOL - 1)];
    const b = boxesB[i & (POOL - 1)];
    acc += fn(a, b);
  }
  const dt = performance.now() - t0;
  if (!Number.isFinite(acc)) console.log('sink', acc);
  return dt;
}

function benchIntersects(fn: (a: AABB, b: AABB) => boolean): number {
  let acc = 0;
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    const a = boxesA[i & (POOL - 1)];
    const b = boxesB[i & (POOL - 1)];
    if (fn(a, b)) acc++;
  }
  const dt = performance.now() - t0;
  if (acc < 0) console.log('sink', acc);
  return dt;
}

function benchTriTri(fn: (a0: Vec3, a1: Vec3, a2: Vec3, b0: Vec3, b1: Vec3, b2: Vec3) => boolean): number {
  let acc = 0;
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    const t = tris[i & (POOL - 1)];
    if (fn(t[0], t[1], t[2], t[3], t[4], t[5])) acc++;
  }
  const dt = performance.now() - t0;
  if (acc < 0) console.log('sink', acc);
  return dt;
}

function median(fn: () => number, reps: number): number {
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) xs.push(fn());
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

function main(): void {
  // warm up JIT
  benchSignedGap(ADP.signedGap); benchSignedGap(OB.signedGap);
  benchIntersects(ADP.intersects); benchIntersects(OB.intersects);
  benchTriTri(ADP.triTriIntersect); benchTriTri(origTri);

  const REPS = 7;
  const sgA = median(() => benchSignedGap(ADP.signedGap), REPS);
  const sgO = median(() => benchSignedGap(OB.signedGap), REPS);
  const inA = median(() => benchIntersects(ADP.intersects), REPS);
  const inO = median(() => benchIntersects(OB.intersects), REPS);
  const ttA = median(() => benchTriTri(ADP.triTriIntersect), REPS);
  const ttO = median(() => benchTriTri(origTri), REPS);

  console.log(`=== PERF (median of ${REPS} reps, ${ITERS} iters/rep) ===`);
  const row = (name: string, a: number, o: number) =>
    console.log(
      `  ${name.padEnd(16)} adapter=${a.toFixed(2)}ms  original=${o.toFixed(2)}ms  ratio(adp/orig)=${(a / o).toFixed(2)}x`,
    );
  row('signedGap', sgA, sgO);
  row('intersects', inA, inO);
  row('triTriIntersect', ttA, ttO);
  const totA = sgA + inA + ttA;
  const totO = sgO + inO + ttO;
  console.log(`  ${'TOTAL'.padEnd(16)} adapter=${totA.toFixed(2)}ms  original=${totO.toFixed(2)}ms  ratio=${(totA / totO).toFixed(2)}x`);
}

main();
