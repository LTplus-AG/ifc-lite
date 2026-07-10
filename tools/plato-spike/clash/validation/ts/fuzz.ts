/* Differential fuzz: adapter (Plato-backed) vs hand-written originals.
 * Compares every result BIT-EXACTLY via DataView f64 bit patterns.
 *
 * - Main batch: 20000 cases, mulberry32 seed 0xC0FFEE, coords in [-100,100]
 *   plus injected degeneracies (zero-area tris, identical points, touching
 *   boxes). Any non-NaN mismatch is a FAILURE.
 * - NaN batch: a small run with NaN coords. Divergences are REPORTED, not
 *   failed (Math.max/min propagate NaN, the Plato ternary min/max does not). */

import type { Vec3, AABB } from './types.js';
import * as ADP from './adapter.js';
import * as OV from './original/vec3.js';
import * as OB from './original/aabb.js';
import { triTriIntersect as origTri } from './original/triangle-intersect.js';

// ---- bit-exact comparison ----
const dv = new DataView(new ArrayBuffer(8));
function bits(x: number): bigint {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0);
}
function eqNum(a: number, b: number): boolean {
  return bits(a) === bits(b);
}
function eqVec(a: Vec3, b: Vec3): boolean {
  return eqNum(a[0], b[0]) && eqNum(a[1], b[1]) && eqNum(a[2], b[2]);
}
function eqBox(a: AABB, b: AABB): boolean {
  return eqVec(a.min as Vec3, b.min as Vec3) && eqVec(a.max as Vec3, b.max as Vec3);
}
function anyNaNNum(...xs: number[]): boolean {
  return xs.some((x) => Number.isNaN(x));
}

// ---- mulberry32 PRNG ----
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

// ---- per-function mismatch tracking ----
interface Counter {
  name: string;
  checked: number;
  mismatchNonNaN: number;
  mismatchNaN: number;
  samples: string[];
}
const counters = new Map<string, Counter>();
function counter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = { name, checked: 0, mismatchNonNaN: 0, mismatchNaN: 0, samples: [] };
    counters.set(name, c);
  }
  return c;
}

/** record a numeric comparison; inputsHaveNaN => NaN-batch classification. */
function chkNum(name: string, adp: number, org: number, inputsHaveNaN: boolean, ctx: string): void {
  const c = counter(name);
  c.checked++;
  if (eqNum(adp, org)) return;
  const isNaNRelated = inputsHaveNaN || Number.isNaN(adp) || Number.isNaN(org);
  if (isNaNRelated) c.mismatchNaN++;
  else c.mismatchNonNaN++;
  if (c.samples.length < 4) {
    c.samples.push(`${ctx} adp=${adp} org=${org} bitsA=${bits(adp).toString(16)} bitsO=${bits(org).toString(16)}`);
  }
}
function chkVec(name: string, adp: Vec3, org: Vec3, inputsHaveNaN: boolean, ctx: string): void {
  const c = counter(name);
  c.checked++;
  if (eqVec(adp, org)) return;
  const isNaNRelated = inputsHaveNaN || anyNaNNum(...adp, ...org);
  if (isNaNRelated) c.mismatchNaN++;
  else c.mismatchNonNaN++;
  if (c.samples.length < 4) c.samples.push(`${ctx} adp=${JSON.stringify(adp)} org=${JSON.stringify(org)}`);
}
function chkBox(name: string, adp: AABB, org: AABB, inputsHaveNaN: boolean, ctx: string): void {
  const c = counter(name);
  c.checked++;
  if (eqBox(adp, org)) return;
  const isNaNRelated =
    inputsHaveNaN || anyNaNNum(...(adp.min as Vec3), ...(adp.max as Vec3), ...(org.min as Vec3), ...(org.max as Vec3));
  if (isNaNRelated) c.mismatchNaN++;
  else c.mismatchNonNaN++;
  if (c.samples.length < 4) c.samples.push(`${ctx} adp=${JSON.stringify(adp)} org=${JSON.stringify(org)}`);
}
function chkBool(name: string, adp: boolean, org: boolean, inputsHaveNaN: boolean, ctx: string): void {
  const c = counter(name);
  c.checked++;
  if (adp === org) return;
  if (inputsHaveNaN) c.mismatchNaN++;
  else c.mismatchNonNaN++;
  if (c.samples.length < 4) c.samples.push(`${ctx} adp=${adp} org=${org}`);
}

// ---- exercise every function on one drawn case ----
function runCase(
  a0: Vec3, a1: Vec3, a2: Vec3,
  b0: Vec3, b1: Vec3, b2: Vec3,
  boxA: AABB, boxB: AABB,
  s: number,
  hasNaN: boolean,
  ctx: string,
): void {
  // vec3 primitives
  chkVec('sub', ADP.sub(a0, b0), OV.sub(a0, b0), hasNaN, ctx);
  chkVec('add', ADP.add(a0, b0), OV.add(a0, b0), hasNaN, ctx);
  chkVec('scale', ADP.scale(a0, s), OV.scale(a0, s), hasNaN, ctx);
  chkVec('cross', ADP.cross(a0, b0), OV.cross(a0, b0), hasNaN, ctx);
  chkNum('dot', ADP.dot(a0, b0), OV.dot(a0, b0), hasNaN, ctx);
  chkNum('lenSq', ADP.lenSq(a0), OV.lenSq(a0), hasNaN, ctx);
  chkNum('distSq', ADP.distSq(a0, b0), OV.distSq(a0, b0), hasNaN, ctx);
  chkVec('mid', ADP.mid(a0, b0), OV.mid(a0, b0), hasNaN, ctx);
  chkVec('centroid', ADP.centroid(a0, a1, a2), OV.centroid(a0, a1, a2), hasNaN, ctx);

  // aabb / box primitives
  chkBox('inflate', ADP.inflate(boxA, s), OB.inflate(boxA, s), hasNaN, ctx);
  chkVec('center', ADP.center(boxA), OB.center(boxA), hasNaN, ctx);
  chkBool('intersects', ADP.intersects(boxA, boxB), OB.intersects(boxA, boxB), hasNaN, ctx);
  chkNum('signedGap', ADP.signedGap(boxA, boxB), OB.signedGap(boxA, boxB), hasNaN, ctx);
  chkBox('overlapBounds', ADP.overlapBounds(boxA, boxB), OB.overlapBounds(boxA, boxB), hasNaN, ctx);
  chkBox('boundsOfPoints', ADP.boundsOfPoints(a0, b0), OB.boundsOfPoints(a0, b0), hasNaN, ctx);
  chkBool('aabbContains', ADP.aabbContains(boxA, boxB), OB.aabbContains(boxA, boxB), hasNaN, ctx);

  // triangle-triangle SAT
  chkBool('triTriIntersect', ADP.triTriIntersect(a0, a1, a2, b0, b1, b2), origTri(a0, a1, a2, b0, b1, b2), hasNaN, ctx);
}

// ---- input generation ----
function boxFromPts(p: Vec3, q: Vec3): AABB {
  return {
    min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])],
    max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])],
  };
}

function main(): void {
  const rng = mulberry32(0xc0ffee);
  const coord = () => rng() * 200 - 100;
  const vec = (): Vec3 => [coord(), coord(), coord()];

  const N = 20000;
  for (let i = 0; i < N; i++) {
    let a0 = vec();
    let a1 = vec();
    let a2 = vec();
    let b0 = vec();
    let b1 = vec();
    let b2 = vec();
    const s = coord();

    // degeneracy injection: ~30% of cases carry some degenerate structure.
    const deg = Math.floor(rng() * 10);
    if (deg === 0) {
      // zero-area triangle A: duplicate vertex
      a1 = [a0[0], a0[1], a0[2]];
    } else if (deg === 1) {
      // zero-area triangle A: collinear third vertex
      const t = rng() * 2 - 0.5;
      a2 = [a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t, a0[2] + (a1[2] - a0[2]) * t];
    } else if (deg === 2) {
      // identical triangles A and B (coincident faces)
      b0 = [a0[0], a0[1], a0[2]];
      b1 = [a1[0], a1[1], a1[2]];
      b2 = [a2[0], a2[1], a2[2]];
    } else if (deg === 3) {
      // all six points identical
      a1 = [a0[0], a0[1], a0[2]];
      a2 = [a0[0], a0[1], a0[2]];
      b0 = [a0[0], a0[1], a0[2]];
      b1 = [a0[0], a0[1], a0[2]];
      b2 = [a0[0], a0[1], a0[2]];
    }

    // boxes: two random point pairs; some touch / share a face.
    let boxA = boxFromPts(vec(), vec());
    let boxB = boxFromPts(vec(), vec());
    const bdeg = Math.floor(rng() * 8);
    if (bdeg === 0) {
      // touching boxes: B.min.x coincides with A.max.x
      boxB = {
        min: [boxA.max[0], boxB.min[1], boxB.min[2]],
        max: [boxA.max[0] + (boxB.max[0] - boxB.min[0]), boxB.max[1], boxB.max[2]],
      };
    } else if (bdeg === 1) {
      // B fully inside A (contains)
      const c = ADP.center(boxA);
      boxB = { min: [c[0] - 1, c[1] - 1, c[2] - 1], max: [c[0] + 1, c[1] + 1, c[2] + 1] };
    } else if (bdeg === 2) {
      // degenerate zero-volume box A (a point)
      boxA = { min: [a0[0], a0[1], a0[2]], max: [a0[0], a0[1], a0[2]] };
    }

    runCase(a0, a1, a2, b0, b1, b2, boxA, boxB, s, false, `case#${i}`);
  }

  // ---- report main batch ----
  let totalNonNaN = 0;
  let totalChecked = 0;
  console.log('=== DIFFERENTIAL FUZZ (main batch, N=' + N + ', seed=0xC0FFEE) ===');
  const order = [
    'sub', 'add', 'scale', 'cross', 'dot', 'lenSq', 'distSq', 'mid', 'centroid',
    'inflate', 'center', 'intersects', 'signedGap', 'overlapBounds', 'boundsOfPoints',
    'aabbContains', 'triTriIntersect',
  ];
  for (const name of order) {
    const c = counters.get(name);
    if (!c) continue;
    totalNonNaN += c.mismatchNonNaN;
    totalChecked += c.checked;
    const flag = c.mismatchNonNaN > 0 ? '  <<< MISMATCH' : '';
    console.log(
      `  ${name.padEnd(16)} checked=${String(c.checked).padStart(6)} nonNaN_mismatch=${c.mismatchNonNaN} NaN_mismatch=${c.mismatchNaN}${flag}`,
    );
    if (c.mismatchNonNaN > 0) for (const s of c.samples) console.log(`      sample: ${s}`);
  }
  console.log(`  --- total checked=${totalChecked} nonNaN_mismatch=${totalNonNaN} ---`);

  // ---- NaN batch (small, reported not failed) ----
  console.log('\n=== NaN BATCH (reported, not fatal) ===');
  const nanCounters = new Map<string, Counter>();
  // temporarily redirect counters map
  const savedCounters = new Map(counters);
  counters.clear();
  const NAN = Number.NaN;
  const nanChoices: Vec3[] = [
    [NAN, 1, 2], [1, NAN, 2], [1, 2, NAN], [NAN, NAN, NAN],
  ];
  const rng2 = mulberry32(0x1234);
  const NN = 200;
  for (let i = 0; i < NN; i++) {
    const pick = (): Vec3 => {
      if (rng2() < 0.5) return nanChoices[Math.floor(rng2() * nanChoices.length)];
      return [rng2() * 20 - 10, rng2() * 20 - 10, rng2() * 20 - 10];
    };
    const a0 = pick(), a1 = pick(), a2 = pick();
    const b0 = pick(), b1 = pick(), b2 = pick();
    const boxA = boxFromPts(pick(), pick());
    const boxB = boxFromPts(pick(), pick());
    runCase(a0, a1, a2, b0, b1, b2, boxA, boxB, rng2() * 20 - 10, true, `nan#${i}`);
  }
  for (const name of order) {
    const c = counters.get(name);
    if (!c) continue;
    nanCounters.set(name, c);
    if (c.mismatchNaN > 0 || c.mismatchNonNaN > 0) {
      console.log(`  ${name.padEnd(16)} divergences=${c.mismatchNaN + c.mismatchNonNaN} / checked=${c.checked}`);
    }
  }
  const anyNanDiverge = [...nanCounters.values()].some((c) => c.mismatchNaN + c.mismatchNonNaN > 0);
  if (!anyNanDiverge) console.log('  (no divergences observed in NaN batch)');

  // restore for exit code decision
  counters.clear();
  for (const [k, v] of savedCounters) counters.set(k, v);

  console.log('\n=== VERDICT ===');
  if (totalNonNaN === 0) {
    console.log('PASS: 0 non-NaN mismatches across all functions.');
    process.exit(0);
  } else {
    console.log(`FAIL: ${totalNonNaN} non-NaN mismatches.`);
    process.exit(1);
  }
}

main();
