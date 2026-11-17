/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSplatSphericalHarmonics, getQuaternionScaledAxes } from '@luma.gl/splats';
import type { NormalizedGaussianAttributes } from './gaussian/gaussian-attributes.js';
import type { GaussianSplatErrorCode } from './gaussian/gaussian-errors.js';
import {
  decomposeSimilarity, shRotationFor, transformGaussianRows,
  type GaussianRowTarget, type ShRotation, type SimilarityPlacement,
} from './gaussian/gaussian-placement.js';

type Degree = 0 | 1 | 2 | 3;
type Quat = [number, number, number, number];
type Vec3 = [number, number, number];
/** Row-major 3x3; every oracle below is built from these test-local helpers, not the module's maths. */
type Mat3 = number[][];
type FullTarget = GaussianRowTarget & { sphericalHarmonics: Float32Array };

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];

/** mulberry32: deterministic samples, so every tolerance is checked against fixed data. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shoemake's uniform unit quaternion, WXYZ. */
function randomQuaternion(random: () => number): Quat {
  const u = random();
  const a = 2 * Math.PI * random();
  const b = 2 * Math.PI * random();
  return [Math.sqrt(1 - u) * Math.sin(a), Math.sqrt(1 - u) * Math.cos(a), Math.sqrt(u) * Math.sin(b), Math.sqrt(u) * Math.cos(b)];
}

function randomUnit(random: () => number): Vec3 {
  const z = 2 * random() - 1;
  const phi = 2 * Math.PI * random();
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** R(q) through axis-angle and Rodrigues' formula, independent of quaternion algebra. */
function rotationMatrix(q: ArrayLike<number>): Mat3 {
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  const [w, x, y, z] = [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
  const sinHalf = Math.hypot(x, y, z);
  const angle = 2 * Math.atan2(sinHalf, w);
  const [nx, ny, nz] = sinHalf === 0 ? [1, 0, 0] : [x / sinHalf, y / sinHalf, z / sinHalf];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [c + t * nx * nx, t * nx * ny - s * nz, t * nx * nz + s * ny],
    [t * ny * nx + s * nz, c + t * ny * ny, t * ny * nz - s * nx],
    [t * nz * nx - s * ny, t * nz * ny + s * nx, c + t * nz * nz],
  ];
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  return a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}

function transpose(a: Mat3): Mat3 {
  return [0, 1, 2].map(i => [a[0][i], a[1][i], a[2][i]]);
}

/** Column-major 4x4 of `t + s R(q) p`. */
function similarity(q: ArrayLike<number>, s: number, t: readonly number[]): number[] {
  const r = rotationMatrix(q);
  const m = [...IDENTITY];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] = s * r[row][col];
  [m[12], m[13], m[14]] = t;
  return m;
}

/** Sigma = R(q) diag(s^2) R(q)^T. */
function covariance(q: ArrayLike<number>, s: ArrayLike<number>): Mat3 {
  const r = rotationMatrix(q);
  return multiply(multiply(r, [[s[0] ** 2, 0, 0], [0, s[1] ** 2, 0], [0, 0, s[2] ** 2]]), transpose(r));
}

function basisCount(degree: Degree): number {
  return (degree + 1) ** 2 - 1;
}

function randomSource(random: () => number, count: number, degree: Degree): NormalizedGaussianAttributes {
  const rotations = new Float32Array(count * 4);
  for (let row = 0; row < count; row++) rotations.set(randomQuaternion(random), row * 4);
  return {
    count,
    positions: Float32Array.from({ length: count * 3 }, () => (random() - 0.5) * 20),
    scales: Float32Array.from({ length: count * 3 }, () => 10 ** (-3 * random())),
    rotations,
    colors: new Float32Array(count * 4).fill(1),
    opacities: new Float32Array(count).fill(0.5),
    sphericalHarmonics: Float32Array.from({ length: count * basisCount(degree) * 3 }, () => 2 * random() - 1),
    sphericalHarmonicsDegree: degree,
  };
}

function makeTarget(rows: number, shBasisCount: number, fill = 0): FullTarget {
  return {
    positions: new Float32Array(rows * 3).fill(fill),
    scales: new Float32Array(rows * 3).fill(fill),
    rotations: new Float32Array(rows * 4).fill(fill),
    sphericalHarmonics: new Float32Array(rows * shBasisCount * 3).fill(fill),
    shBasisCount,
  };
}

function place(
  source: NormalizedGaussianAttributes, placement: SimilarityPlacement, sh: ShRotation,
  anchor: readonly [number, number, number] = ZERO,
): FullTarget {
  const target = makeTarget(source.count, basisCount(source.sphericalHarmonicsDegree));
  transformGaussianRows(source, placement, sh, anchor, target, 0, 0, source.count);
  return target;
}

/** max |f_after(d) - f_before(R^T d)| over rows, directions and channels, both evaluated by upstream. */
function invarianceError(
  before: Float32Array, beforeDegree: Degree, after: Float32Array, afterDegree: Degree, r: Mat3, directions: Vec3[],
): number {
  const beforeStride = basisCount(beforeDegree) * 3;
  const afterStride = basisCount(afterDegree) * 3;
  let worst = 0;
  for (let row = 0; row * beforeStride < before.length; row++) {
    const original = before.subarray(row * beforeStride, (row + 1) * beforeStride);
    const rotated = after.subarray(row * afterStride, (row + 1) * afterStride);
    for (const d of directions) {
      const local = [0, 1, 2].map(i => r[0][i] * d[0] + r[1][i] * d[1] + r[2][i] * d[2]);
      const expected = evaluateSplatSphericalHarmonics(ZERO, original, local, beforeDegree);
      const actual = evaluateSplatSphericalHarmonics(ZERO, rotated, d, afterDegree);
      for (let channel = 0; channel < 3; channel++) worst = Math.max(worst, Math.abs(actual[channel] - expected[channel]));
    }
  }
  return worst;
}

function transposeBand(band: Float64Array): Float64Array {
  const size = Math.round(Math.sqrt(band.length));
  return Float64Array.from({ length: band.length }, (_, index) => band[(index % size) * size + Math.floor(index / size)]);
}

test('#8564 decomposeSimilarity recovers scale, proper rotation and translation of random similarities', () => {
  const random = rng(8564);
  for (let trial = 0; trial < 200; trial++) {
    const q = randomQuaternion(random);
    const s = 10 ** (6 * random() - 3);
    const t = [(random() - 0.5) * 1e7, (random() - 0.5) * 1e7, (random() - 0.5) * 1e3];
    const matrix = similarity(q, s, t);
    const placement = decomposeSimilarity(Float64Array.from(matrix));
    const rotation: Mat3 = [0, 1, 2].map(row => [0, 1, 2].map(col => placement.rotation[col * 3 + row]));
    const fromQuaternion = rotationMatrix(placement.quaternion);
    const gram = multiply(transpose(rotation), rotation);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        assert.ok(Math.abs(placement.scale * rotation[row][col] - matrix[col * 4 + row]) <= 1e-12 * s, 'reconstructs L');
        assert.ok(Math.abs(fromQuaternion[row][col] - rotation[row][col]) <= 1e-12, 'quaternion is the same rotation');
        assert.ok(Math.abs(gram[row][col] - (row === col ? 1 : 0)) <= 1e-14, 'orthonormal');
      }
    }
    assert.ok(Math.abs(placement.scale / s - 1) <= 1e-12);
    assert.deepEqual(placement.translation, [t[0], t[1], t[2]]);
    const dot = q.reduce((sum, value, index) => sum + value * placement.quaternion[index], 0);
    assert.ok(Math.abs(Math.abs(dot) - 1) <= 1e-12 && placement.quaternion[0] >= 0, 'input rotation up to quaternion sign');
    assert.equal(placement.identityRotation, false);
  }
});

test('#8564 a pure uniform scale is exactly the identity rotation; float32-rounded rotations are accepted', () => {
  const scaled = decomposeSimilarity([2.5, 0, 0, 0, 0, 2.5, 0, 0, 0, 0, 2.5, 0, 7, -8, 9, 1]);
  assert.equal(scaled.identityRotation, true);
  assert.equal(scaled.scale, 2.5);
  assert.deepEqual(scaled.quaternion, [1, 0, 0, 0]);
  assert.deepEqual([...scaled.rotation], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(scaled.translation, [7, -8, 9]);
  const halfTurn = decomposeSimilarity([-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(halfTurn.identityRotation, false);
  assert.deepEqual(halfTurn.quaternion.map(Math.abs), [0, 0, 0, 1]);
  const random = rng(7);
  for (let trial = 0; trial < 50; trial++) {
    const s = 10 ** (4 * random() - 2);
    const placement = decomposeSimilarity(Float32Array.from(similarity(randomQuaternion(random), s, [1, 2, 3])));
    assert.ok(Math.abs(placement.scale / s - 1) < 1e-6);
    // The float32 residue (~1e-7) is removed: downstream maths sees an orthonormal rotation.
    const rotation: Mat3 = [0, 1, 2].map(row => [0, 1, 2].map(col => placement.rotation[col * 3 + row]));
    const gram = multiply(transpose(rotation), rotation);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(gram[i][j] - (i === j ? 1 : 0)) <= 1e-14);
  }
});

test('#8564 decomposeSimilarity rejects malformed, non-similar and mirrored placements by exact code', () => {
  const at = (index: number, value: number): number[] => IDENTITY.map((v, i) => (i === index ? value : v));
  const diagonal = (a: number, b: number, c: number): number[] => [a, 0, 0, 0, 0, b, 0, 0, 0, 0, c, 0, 0, 0, 0, 1];
  const q = randomQuaternion(rng(9));
  const mirrored = similarity(q, 2, [1, 2, 3]).map((v, i) => (i >= 8 && i <= 10 ? -v : v));
  const cases: Array<[string, ArrayLike<number>, GaussianSplatErrorCode]> = [
    ['15 values', IDENTITY.slice(0, 15), 'invalid-placement'],
    ['17 values', [...IDENTITY, 0], 'invalid-placement'],
    ['NaN linear entry', at(5, Number.NaN), 'invalid-placement'],
    ['infinite translation', at(13, Number.POSITIVE_INFINITY), 'invalid-placement'],
    ['projective bottom row', at(3, 1e-9), 'invalid-placement'],
    ['bottom row w = 2', at(15, 2), 'invalid-placement'],
    ['shear 1e-2', at(4, 1e-2), 'non-similarity-placement'],
    ['shear 2e-6, above the 1e-6 tolerance', at(4, 2e-6), 'non-similarity-placement'],
    ['non-uniform scale', diagonal(1, 1.001, 1), 'non-similarity-placement'],
    ['zero scale', diagonal(0, 0, 0), 'non-similarity-placement'],
    ['near-zero scale', similarity(q, 1e-40, [0, 0, 0]), 'non-similarity-placement'],
    ['scale beyond float32', similarity(q, 1e39, [0, 0, 0]), 'non-similarity-placement'],
    ['mirrored rotation', mirrored, 'unsupported-reflection'],
    ['point reflection', diagonal(-2, -2, -2), 'unsupported-reflection'],
  ];
  for (const [name, matrix, code] of cases) {
    assert.throws(() => decomposeSimilarity(matrix), { name: 'GaussianSplatError', code }, name);
  }
  assert.equal(decomposeSimilarity(at(4, 5e-7)).identityRotation, false, 'float32-level noise is not a shear');
});

test('#8564 placed covariance equals L Sigma L^T for random Gaussians and placements', () => {
  const random = rng(2);
  // Pin the oracle's quaternion convention to upstream's renderer: its one-sigma axes are R(q)'s columns.
  for (let trial = 0; trial < 20; trial++) {
    const q = randomQuaternion(random);
    const axes = getQuaternionScaledAxes(q, [1, 1, 1]);
    const r = rotationMatrix(q);
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) assert.ok(Math.abs(axes[col][row] - r[row][col]) < 1e-12);
  }
  const count = 48;
  const source = randomSource(random, count, 0);
  for (let trial = 0; trial < 25; trial++) {
    const q = trial === 0 ? [1, 0, 0, 0] : randomQuaternion(random);
    const matrix = similarity(q, 10 ** (4 * random() - 2), [random() * 100, -50, 3]);
    const placement = decomposeSimilarity(matrix);
    assert.equal(placement.identityRotation, trial === 0);
    const target = place(source, placement, shRotationFor(placement, 0));
    const l: Mat3 = [0, 1, 2].map(row => [0, 1, 2].map(col => matrix[col * 4 + row]));
    for (let row = 0; row < count; row++) {
      const sigma = covariance(source.rotations.subarray(row * 4, row * 4 + 4), source.scales.subarray(row * 3, row * 3 + 3));
      const expected = multiply(multiply(l, sigma), transpose(l));
      const actual = covariance(target.rotations.subarray(row * 4, row * 4 + 4), target.scales.subarray(row * 3, row * 3 + 3));
      // float32 q' and s' (half-ulp 6e-8) bound the error near 6e-7 of the largest variance.
      const largest = Math.max(...expected.flat().map(Math.abs));
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) assert.ok(Math.abs(actual[i][j] - expected[i][j]) <= 2e-6 * largest, `row ${row} [${i}][${j}]`);
      }
    }
  }
});

test('#8564 positions equal a float64 4x4 multiply minus the anchor and keep millimetres 5,000 km out', () => {
  const random = rng(3);
  const count = 256;
  const source = randomSource(random, count, 0);
  const cases: Array<{ matrix: number[]; anchor: readonly [number, number, number]; georeferenced: boolean }> = [
    { matrix: similarity(randomQuaternion(random), 0.25 + random(), [12, -7, 3]), anchor: ZERO, georeferenced: false },
    { matrix: similarity(randomQuaternion(random), 10, [-3, 4, 5]), anchor: [1.5, -2.25, 100], georeferenced: false },
    { matrix: similarity(randomQuaternion(random), 1, [4_987_654.321, 5_012_345.678, 432.1]), anchor: [4_987_650, 5_012_350, 430], georeferenced: true },
  ];
  for (const { matrix, anchor, georeferenced } of cases) {
    const placement = decomposeSimilarity(matrix);
    const target = place(source, placement, shRotationFor(placement, 0), anchor);
    let float32WorldError = 0;
    for (let row = 0; row < count; row++) {
      const [x, y, z] = source.positions.subarray(row * 3, row * 3 + 3);
      for (let axis = 0; axis < 3; axis++) {
        const world = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        const expected = world - anchor[axis];
        const error = Math.abs(target.positions[row * 3 + axis] - expected);
        assert.ok(error <= 2 ** -23 * Math.abs(expected) + 1e-9, `row ${row} axis ${axis}: float32 rounding of the anchored value only`);
        assert.ok(error < 1e-3, 'millimetre');
        float32WorldError = Math.max(float32WorldError, Math.abs(Math.fround(world) - world));
      }
    }
    if (georeferenced) assert.ok(float32WorldError > 0.05, 'the case is precision-critical: float32 world coordinates lose decimetres');
  }
});

for (const degree of [1, 2, 3] as const) {
  test(`#8564 rotated degree-${degree} SH evaluate at d as the source did at R^T d (upstream evaluator)`, () => {
    const random = rng(40 + degree);
    const source = randomSource(random, 8, degree);
    const directions = Array.from({ length: 64 }, () => randomUnit(random));
    for (let trial = 0; trial < 4; trial++) {
      const q = randomQuaternion(random);
      const r = rotationMatrix(q);
      const placement = decomposeSimilarity(similarity(q, 0.5 + random(), [random(), random(), random()]));
      const sh = shRotationFor(placement, degree);
      const rotated = place(source, placement, sh).sphericalHarmonics;
      // Coefficients are U(-1, 1); float32 storage of the rotated ones keeps the error near 1e-6.
      const error = invarianceError(source.sphericalHarmonics, degree, rotated, degree, r, directions);
      assert.ok(error <= 1e-5, `invariance error ${error}`);
      // Negative controls: the same oracle rejects the inverse rotation (D^T) and an unrotated bake.
      const inverse = place(source, placement, { degree, bands: sh.bands.map(transposeBand) }).sphericalHarmonics;
      assert.ok(invarianceError(source.sphericalHarmonics, degree, inverse, degree, r, directions) > 1e-2, 'D^T must fail');
      assert.ok(invarianceError(source.sphericalHarmonics, degree, source.sphericalHarmonics, degree, r, directions) > 1e-2, 'no rotation must fail');
    }
  });
}

test('#8564 identity placement with a zero anchor reproduces every column bitwise', () => {
  const random = rng(5);
  for (const degree of [0, 1, 2, 3] as const) {
    const source = randomSource(random, 16, degree);
    const placement = decomposeSimilarity(IDENTITY);
    assert.equal(placement.identityRotation, true);
    const target = place(source, placement, shRotationFor(placement, degree));
    assert.deepEqual(target.positions, source.positions);
    assert.deepEqual(target.scales, source.scales);
    assert.deepEqual(target.rotations, source.rotations);
    assert.deepEqual(target.sphericalHarmonics, source.sphericalHarmonics);
  }
  const source = randomSource(random, 16, 3);
  const placement = decomposeSimilarity([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1]);
  const target = place(source, placement, shRotationFor(placement, 3), [10, 20, 30]);
  assert.deepEqual(target.rotations, source.rotations, 'a pure scale keeps orientation');
  assert.deepEqual(target.sphericalHarmonics, source.sphericalHarmonics, 'a pure scale keeps view-dependent colour');
  assert.deepEqual(target.scales, source.scales.map(value => 2 * value));
  assert.deepEqual(target.positions, source.positions.map(value => 2 * value));
});

test('#8564 degree-1 rows padded into a degree-3 layout zero-fill bands 2-3 and evaluate identically', () => {
  const random = rng(6);
  const source = randomSource(random, 10, 1);
  const q = randomQuaternion(random);
  const placement = decomposeSimilarity(similarity(q, 1.5, [0, 0, 0]));
  const padded = makeTarget(10, 15, Number.NaN);
  transformGaussianRows(source, placement, shRotationFor(placement, 3), ZERO, padded, 0, 0, 10);
  const unpadded = place(source, placement, shRotationFor(placement, 1));
  for (let row = 0; row < 10; row++) {
    const values = padded.sphericalHarmonics.subarray(row * 45, row * 45 + 45);
    assert.deepEqual(values.subarray(0, 9), unpadded.sphericalHarmonics.subarray(row * 9, row * 9 + 9));
    assert.ok(values.subarray(9).every(value => Object.is(value, 0)), 'bands 2-3 are zero, not stale');
  }
  const directions = Array.from({ length: 64 }, () => randomUnit(random));
  assert.ok(invarianceError(source.sphericalHarmonics, 1, padded.sphericalHarmonics, 3, rotationMatrix(q), directions) <= 1e-5);
});

test('#8564 chunked calls write rows at targetRow + row and equal one full call', () => {
  const random = rng(7);
  const count = 23;
  const first = 5;
  const rows = first + count + 3;
  const source = randomSource(random, count, 2);
  const placement = decomposeSimilarity(similarity(randomQuaternion(random), 0.75, [100, 200, 300]));
  const sh = shRotationFor(placement, 2);
  const anchor = [99, 201, 299.5] as const;
  const whole = makeTarget(rows, 8, 42);
  transformGaussianRows(source, placement, sh, anchor, whole, first, 0, count);
  const chunked = makeTarget(rows, 8, 42);
  for (const [start, end] of [[16, 23], [0, 7], [7, 7], [7, 16]]) {
    transformGaussianRows(source, placement, sh, anchor, chunked, first, start, end);
  }
  assert.deepEqual(chunked, whole);
  const alone = place(source, placement, sh, anchor);
  for (const [key, stride] of [['positions', 3], ['scales', 3], ['rotations', 4], ['sphericalHarmonics', 24]] as const) {
    assert.deepEqual(whole[key].subarray(first * stride, (first + count) * stride), alone[key], `${key} row r lands at targetRow + r`);
    assert.ok(whole[key].subarray(0, first * stride).every(value => value === 42), `${key} rows before targetRow untouched`);
    assert.ok(whole[key].subarray((first + count) * stride).every(value => value === 42), `${key} rows after the asset untouched`);
  }
});

test('#8564 unrepresentable placed rows and broken layouts throw instead of writing garbage', () => {
  const random = rng(8);
  const grow = decomposeSimilarity(similarity([1, 0, 0, 0], 1e10, [0, 0, 0]));
  const huge = randomSource(random, 4, 0);
  huge.scales[5] = 1e30;
  assert.throws(() => place(huge, grow, shRotationFor(grow, 0)), { name: 'GaussianSplatError', code: 'invalid-attributes' });
  const tiny = randomSource(random, 4, 0);
  tiny.scales[2] = 1e-20;
  const shrink = decomposeSimilarity(similarity(randomQuaternion(random), 1e-15, [0, 0, 0]));
  assert.throws(() => place(tiny, shrink, shRotationFor(shrink, 0)), { code: 'invalid-attributes' }, 'variance underflows float32');
  const far = randomSource(random, 4, 0);
  far.positions[4] = 3e38;
  assert.throws(() => place(far, grow, shRotationFor(grow, 0)), { code: 'anchor-extent' });

  const source = randomSource(random, 4, 2);
  const placement = decomposeSimilarity(similarity(randomQuaternion(random), 1, [0, 0, 0]));
  const sh = shRotationFor(placement, 2);
  const run = (target: GaussianRowTarget, rotation = sh, targetRow = 0, end = 4, anchor = ZERO) =>
    () => transformGaussianRows(source, placement, rotation, anchor, target, targetRow, 0, end);
  for (const key of ['positions', 'scales', 'rotations', 'sphericalHarmonics'] as const) {
    const target = makeTarget(4, 8);
    target[key] = target[key].subarray(1);
    assert.throws(run(target), RangeError, `an undersized ${key} column must not drop rows silently`);
  }
  assert.throws(run(makeTarget(4, 8), sh, 1), RangeError, 'targetRow pushes rows past the end');
  assert.throws(run(makeTarget(5, 8), sh, 0, 5), RangeError, 'end beyond the source count');
  assert.throws(run(makeTarget(4, 3)), RangeError, 'target SH layout below the source degree');
  assert.throws(run({ ...makeTarget(4, 0), sphericalHarmonics: undefined }), RangeError, 'SH rows need an SH target');
  assert.throws(run(makeTarget(4, 8), shRotationFor(placement, 1)), RangeError, 'rotation must cover the source degree');
  assert.throws(run(makeTarget(4, 8), sh, 0, 4, [0, Number.NaN, 0]), RangeError, 'anchor must be finite');
});
