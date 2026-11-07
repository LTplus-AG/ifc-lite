/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bakes a source-local -> world similarity placement (uniform scale, proper
 * rotation, translation) into packed Gaussian rows re-centred on a float64 RTE
 * anchor. Centres, covariances and view-dependent colour all move with the
 * placement. Pure functions: nothing is cached between calls.
 */

import { evaluateSplatSphericalHarmonics } from '@luma.gl/splats';
import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';
import { GaussianSplatError } from './gaussian-errors.js';

/** A validated `world = scale * rotation * local + translation`. */
export interface SimilarityPlacement {
  /** Uniform scale, a normal float32 > 0. */
  readonly scale: number;
  /** 9 values, column-major (`rotation[column * 3 + row]`), orthonormal with det +1. */
  readonly rotation: Float64Array;
  /** The same rotation as a unit WXYZ quaternion with w >= 0. */
  readonly quaternion: readonly [number, number, number, number];
  readonly translation: readonly [number, number, number];
  /** Exactly the identity rotation (the linear part is a pure uniform scale): rotations and SH copy unchanged. */
  readonly identityRotation: boolean;
}

/** Per-band SH rotation; `bands[l - 1]` is (2l+1)^2 row-major: `out[i] = sum_j D[i * (2l+1) + j] * in[j]`. */
export interface ShRotation { readonly degree: 0 | 1 | 2 | 3; readonly bands: readonly Float64Array[] }

/** Packed destination columns; `shBasisCount` (0, 3, 8 or 15) may exceed the source's, extra bands are zero-filled. */
export interface GaussianRowTarget {
  positions: Float32Array; scales: Float32Array; rotations: Float32Array;
  sphericalHarmonics?: Float32Array; shBasisCount: number;
}

/**
 * Relative tolerance on `L^T L = s^2 I` for the 3x3 linear part `L`. A rotation
 * rounded to float32 is orthonormal to ~1e-7 (half-ulp entries), so 1e-6 accepts
 * float32-sourced placements, with headroom for a few float32 compositions, while
 * rejecting shear or non-uniform scale above one part per million. The accepted
 * residue is removed by re-orthonormalisation, which moves a point by at most
 * ~1e-6 of its distance from the placement origin (0.1 mm at 100 m).
 */
const SIMILARITY_TOLERANCE = 1e-6;
/** The scale multiplies float32 columns, so it must itself be a normal float32 ("near-zero" is below this range). */
const FLOAT32_MIN_NORMAL = 2 ** -126;
const FLOAT32_MAX = 3.4028234663852886e38;
/** Column-major indices of the 3x3 linear part inside a 4x4. */
const LINEAR = [0, 1, 2, 4, 5, 6, 8, 9, 10] as const;
const BANDS = [1, 2, 3] as const;
const BASIS_COUNTS: readonly number[] = [0, 3, 8, 15];
/**
 * cos(polar angle) of each band's sampling ring. 2l+1 azimuths equally spaced on
 * a cone make the band's sample matrix column-orthogonal (see bandRotation); at
 * these heights its condition number is 1, 1.59 and 1.76 for bands 1-3.
 */
const RING_HEIGHTS: readonly number[] = [Math.sqrt(1 / 3), 0.3, 0.25];
/** Singular-pivot and orthogonality threshold for the derived band rotations (float64 work is ~1e-15). */
const BASIS_TOLERANCE = 1e-9;
const ZERO_BASE = [0, 0, 0] as const;

function placementError(code: 'invalid-placement' | 'non-similarity-placement', reason: string): GaussianSplatError {
  return new GaussianSplatError(code, `Gaussian placement ${reason}`);
}

/**
 * Validates a column-major 4x4 source-local -> world matrix and splits it into
 * uniform scale, proper rotation and translation. Throws `invalid-placement`
 * (shape, non-finite, bottom row not exactly [0, 0, 0, 1]),
 * `non-similarity-placement` (shear, non-uniform, zero or non-float32 scale) or
 * `unsupported-reflection` (det < 0: mirrored SH bands are not verified here).
 */
export function decomposeSimilarity(matrix: ArrayLike<number>): SimilarityPlacement {
  if (matrix.length !== 16) throw placementError('invalid-placement', `needs 16 column-major values, got ${matrix.length}`);
  const m = Array.from(matrix);
  if (!m.every(value => Number.isFinite(value))) throw placementError('invalid-placement', 'contains non-finite values');
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) {
    throw placementError('invalid-placement', 'bottom row must be exactly [0, 0, 0, 1]');
  }
  const magnitude = Math.max(...LINEAR.map(index => Math.abs(m[index])));
  if (magnitude === 0) throw placementError('non-similarity-placement', 'has a zero linear part');
  // Dividing by the largest entry keeps the Gram matrix clear of overflow and underflow.
  const columns = [0, 4, 8].map(first => [m[first] / magnitude, m[first + 1] / magnitude, m[first + 2] / magnitude]);
  const gram = (a: number, b: number): number =>
    columns[a][0] * columns[b][0] + columns[a][1] * columns[b][1] + columns[a][2] * columns[b][2];
  const unitScale2 = (gram(0, 0) + gram(1, 1) + gram(2, 2)) / 3;
  const pairs = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]];
  if (pairs.some(([a, b]) => !(Math.abs(gram(a, b) - (a === b ? unitScale2 : 0)) <= SIMILARITY_TOLERANCE * unitScale2))) {
    throw placementError('non-similarity-placement', 'linear part is not a uniform scale times a rotation (shear or non-uniform scale)');
  }
  const unitScale = Math.sqrt(unitScale2);
  const scale = magnitude * unitScale;
  if (!(scale >= FLOAT32_MIN_NORMAL && scale <= FLOAT32_MAX)) {
    throw placementError('non-similarity-placement', `scale ${scale} is zero or outside the normal float32 range`);
  }
  const r = columns.flat().map(value => value / unitScale);
  const determinant = r[0] * (r[4] * r[8] - r[5] * r[7]) + r[1] * (r[5] * r[6] - r[3] * r[8])
    + r[2] * (r[3] * r[7] - r[4] * r[6]);
  if (determinant < 0) {
    throw new GaussianSplatError('unsupported-reflection', 'Gaussian placement mirrors handedness; reflected SH is unsupported');
  }
  const quaternion = quaternionFromRotation(r);
  const identityRotation = quaternion[1] === 0 && quaternion[2] === 0 && quaternion[3] === 0;
  return { scale, rotation: rotationFromQuaternion(quaternion), quaternion, translation: [m[12], m[13], m[14]], identityRotation };
}

/** Shepperd's branch on the largest diagonal term; normalised with w >= 0. `r` is column-major. */
function quaternionFromRotation(r: readonly number[]): [number, number, number, number] {
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 2 * Math.sqrt(1 + trace);
    q = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 >= m11 && m00 >= m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 >= m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
  }
  const norm = Math.hypot(...q) * (q[0] < 0 ? -1 : 1);
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

/** Column-major rotation of a unit WXYZ quaternion (the convention of upstream's splat shaders). */
function rotationFromQuaternion([w, x, y, z]: readonly number[]): Float64Array {
  return Float64Array.of(
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  );
}

/** Band rotations D^1..D^degree for `placement` (exact identities when its rotation is the identity). */
export function shRotationFor(placement: SimilarityPlacement, degree: 0 | 1 | 2 | 3): ShRotation {
  if (!(degree === 0 || degree === 1 || degree === 2 || degree === 3)) {
    throw new RangeError(`Unsupported SH degree ${String(degree)}`);
  }
  const bands = BANDS.filter(band => band <= degree).map(band =>
    placement.identityRotation ? identityMatrix(2 * band + 1) : bandRotation(placement.rotation, band));
  return { degree, bands };
}

/**
 * Rotation of SH band l under R, derived from upstream's evaluator so the basis
 * convention (order, signs, normalisation) is upstream's by construction.
 *
 * Let Y(d) be the row of upstream's 2l+1 band-l basis values at unit direction d;
 * a band stores f_c(d) = Y(d) c. Band-l spaces are closed under rotation, so one
 * matrix D satisfies Y(R^T d) = Y(d) D for every d. Hence
 *   f_c(R^T d) = Y(d) (D c) = f_{Dc}(d):
 * coefficients D c evaluate at world direction d exactly as c did at the
 * source-local direction R^T d, i.e. the lobe turns with the placement. Stacking
 * that identity at 2l+1 sample directions d_i (rows B_i = Y(d_i) and
 * Brot_i = Y(R^T d_i)) gives Brot = B D, so D = B^{-1} Brot.
 *
 * The d_i are 2l+1 equally spaced azimuths on a cone. Each real basis function is
 * P(theta) cos(m phi) or P(theta) sin(m phi) with |m| <= l, and discrete Fourier
 * orthogonality on 2l+1 equally spaced azimuths makes B's columns orthogonal, so
 * B is invertible whenever no P vanishes at the ring height. Upstream's basis is
 * orthonormal, so D must be orthogonal; a singular B or a non-orthogonal D means
 * upstream's basis changed and the bake would be unverified, so both fail closed.
 */
function bandRotation(rotation: Float64Array, band: 1 | 2 | 3): Float64Array {
  const size = 2 * band + 1;
  const height = RING_HEIGHTS[band - 1];
  const radius = Math.sqrt(1 - height * height);
  const basis = new Float64Array(size * size);
  const rotated = new Float64Array(size * size);
  for (let i = 0; i < size; i++) {
    const azimuth = (2 * Math.PI * i) / size;
    const d = [radius * Math.cos(azimuth), radius * Math.sin(azimuth), height];
    // (R^T d)_k is column k of R dotted with d.
    const local = [0, 3, 6].map(c => rotation[c] * d[0] + rotation[c + 1] * d[1] + rotation[c + 2] * d[2]);
    basis.set(bandBasis(d, band), i * size);
    rotated.set(bandBasis(local, band), i * size);
  }
  const result = solveLinear(basis, rotated, size);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      let dot = 0;
      for (let k = 0; k < size; k++) dot += result[i * size + k] * result[j * size + k];
      if (!(Math.abs(dot - (i === j ? 1 : 0)) <= BASIS_TOLERANCE)) {
        throw new GaussianSplatError('upstream-capability-missing', `Upstream SH band ${band} is not an orthonormal rotation-closed basis`);
      }
    }
  }
  return result;
}

/** Upstream's band basis values Y_j(direction), read by evaluating unit coefficient vectors on a zero base colour. */
function bandBasis(direction: ArrayLike<number>, band: 1 | 2 | 3): Float64Array {
  const size = 2 * band + 1;
  const first = band * band - 1;
  const unit = new Float64Array(((band + 1) ** 2 - 1) * 3);
  const values = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    unit[(first + j) * 3] = 1;
    values[j] = evaluateSplatSphericalHarmonics(ZERO_BASE, unit, direction, band)[0];
    unit[(first + j) * 3] = 0;
  }
  return values;
}

/** Solves A X = B (n x n, row-major) by Gauss-Jordan elimination with partial pivoting; consumes both inputs. */
function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array {
  let magnitude = 0;
  for (const value of a) magnitude = Math.max(magnitude, Math.abs(value));
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(a[row * n + column]) > Math.abs(a[pivot * n + column])) pivot = row;
    }
    if (!(Math.abs(a[pivot * n + column]) > BASIS_TOLERANCE * magnitude)) {
      throw new GaussianSplatError('upstream-capability-missing', 'Upstream SH basis is singular at the sample directions');
    }
    if (pivot !== column) swapRows([a, b], n, pivot, column);
    for (let row = 0; row < n; row++) {
      const factor = row === column ? 0 : a[row * n + column] / a[column * n + column];
      if (factor === 0) continue;
      for (let k = 0; k < n; k++) {
        a[row * n + k] -= factor * a[column * n + k];
        b[row * n + k] -= factor * b[column * n + k];
      }
    }
  }
  for (let row = 0; row < n; row++) {
    for (let k = 0; k < n; k++) b[row * n + k] /= a[row * n + row];
  }
  return b;
}

function swapRows(matrices: readonly Float64Array[], n: number, first: number, second: number): void {
  for (const matrix of matrices) {
    const row = matrix.slice(first * n, first * n + n);
    matrix.copyWithin(first * n, second * n, second * n + n);
    matrix.set(row, second * n);
  }
}

function identityMatrix(size: number): Float64Array {
  return Float64Array.from({ length: size * size }, (_, index) => (index % (size + 1) === 0 ? 1 : 0));
}

/**
 * Transforms source rows [start, end) into target rows `targetRow + row`:
 * `targetRow` is the asset's first packed row and every row keeps its source
 * offset, so calls over disjoint chunks compose into exactly one full call.
 *
 * - position' = float32(s R p + (t - anchor)), all in float64, so anchored
 *   precision follows the local extent rather than the world magnitude;
 * - rotation' = normalize(q_R (x) q) (Hamilton, WXYZ) and scale' = s * scale,
 *   i.e. covariance' = L covariance L^T for L = s R;
 * - SH band l' = D^l band l per RGB channel (see shRotationFor); bands above the
 *   source degree are zero-filled up to `target.shBasisCount`;
 * - `placement.identityRotation` copies rotations and SH unchanged.
 *
 * `sh` must come from `shRotationFor(placement, degree >= source degree)`.
 * Throws `anchor-extent` when an anchored position overflows float32,
 * `invalid-attributes` when a placed scale or its variance is not a positive
 * finite float32 (or the source arrays disagree with their count and degree),
 * and RangeError on caller contract violations (row range, undersized target,
 * SH layout, `sh` below the source degree). Rows written before a throw stay;
 * callers discard the target on error.
 */
export function transformGaussianRows(
  source: NormalizedGaussianAttributes, placement: SimilarityPlacement, sh: ShRotation,
  anchor: readonly [number, number, number], target: GaussianRowTarget, targetRow: number, start: number, end: number,
): void {
  const sourceBasis = (source.sphericalHarmonicsDegree + 1) ** 2 - 1;
  checkRowContract(source, sourceBasis, sh, anchor, target, targetRow, start, end);
  const { scale, identityRotation } = placement;
  const [qw, qx, qy, qz] = placement.quaternion;
  const linear = placement.rotation.map(value => value * scale);
  const offset = [0, 1, 2].map(axis => placement.translation[axis] - anchor[axis]);
  const { positions, scales, rotations } = source;
  for (let row = start; row < end; row++) {
    const out = targetRow + row;
    const x = positions[row * 3], y = positions[row * 3 + 1], z = positions[row * 3 + 2];
    for (let axis = 0; axis < 3; axis++) {
      const position = Math.fround(linear[axis] * x + linear[axis + 3] * y + linear[axis + 6] * z + offset[axis]);
      if (!Number.isFinite(position)) {
        throw new GaussianSplatError('anchor-extent', `Gaussian row ${row} is outside the float32 range of its anchor`);
      }
      target.positions[out * 3 + axis] = position;
      const sigma = Math.fround(scale * scales[row * 3 + axis]);
      const variance = Math.fround(sigma * sigma);
      if (!(sigma > 0 && variance > 0 && variance < Infinity)) {
        throw new GaussianSplatError('invalid-attributes', `Placed Gaussian scale at row ${row} is not a representable covariance`);
      }
      target.scales[out * 3 + axis] = sigma;
    }
    if (identityRotation) {
      target.rotations.set(rotations.subarray(row * 4, row * 4 + 4), out * 4);
      continue;
    }
    const w = rotations[row * 4], a = rotations[row * 4 + 1], b = rotations[row * 4 + 2], c = rotations[row * 4 + 3];
    const rw = qw * w - qx * a - qy * b - qz * c;
    const rx = qw * a + qx * w + qy * c - qz * b;
    const ry = qw * b - qx * c + qy * w + qz * a;
    const rz = qw * c + qx * b - qy * a + qz * w;
    const norm = Math.sqrt(rw * rw + rx * rx + ry * ry + rz * rz);
    if (!(norm > 0 && norm < Infinity)) {
      throw new GaussianSplatError('invalid-attributes', `Gaussian rotation at row ${row} is not a unit quaternion`);
    }
    target.rotations[out * 4] = rw / norm;
    target.rotations[out * 4 + 1] = rx / norm;
    target.rotations[out * 4 + 2] = ry / norm;
    target.rotations[out * 4 + 3] = rz / norm;
  }
  if (target.sphericalHarmonics !== undefined) {
    writeHarmonics(source, sourceBasis, sh, identityRotation, target.sphericalHarmonics, target.shBasisCount, targetRow, start, end);
  }
}

function writeHarmonics(
  source: NormalizedGaussianAttributes, sourceBasis: number, sh: ShRotation, identity: boolean,
  harmonics: Float32Array, targetBasis: number, targetRow: number, start: number, end: number,
): void {
  const input = new Float64Array(7);
  const coefficients = source.sphericalHarmonics;
  for (let row = start; row < end; row++) {
    const from = row * sourceBasis * 3;
    const to = (targetRow + row) * targetBasis * 3;
    if (identity) {
      harmonics.set(coefficients.subarray(from, from + sourceBasis * 3), to);
    } else {
      for (let band = 1; band <= source.sphericalHarmonicsDegree; band++) {
        const size = 2 * band + 1;
        const first = (band * band - 1) * 3;
        const matrix = sh.bands[band - 1];
        for (let channel = 0; channel < 3; channel++) {
          for (let j = 0; j < size; j++) input[j] = coefficients[from + first + j * 3 + channel];
          for (let i = 0; i < size; i++) {
            let sum = 0;
            for (let j = 0; j < size; j++) sum += matrix[i * size + j] * input[j];
            const value = Math.fround(sum);
            if (!Number.isFinite(value)) {
              throw new GaussianSplatError('invalid-attributes', `Rotated SH at row ${row} overflows float32`);
            }
            harmonics[to + first + i * 3 + channel] = value;
          }
        }
      }
    }
    harmonics.fill(0, to + sourceBasis * 3, to + targetBasis * 3);
  }
}

function checkRowContract(
  source: NormalizedGaussianAttributes, sourceBasis: number, sh: ShRotation, anchor: readonly number[],
  target: GaussianRowTarget, targetRow: number, start: number, end: number,
): void {
  const { count, sphericalHarmonicsDegree: degree } = source;
  if (source.positions.length !== count * 3 || source.scales.length !== count * 3
    || source.rotations.length !== count * 4 || source.sphericalHarmonics.length !== count * sourceBasis * 3) {
    throw new GaussianSplatError('invalid-attributes', 'Gaussian attribute arrays disagree with their count and SH degree');
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > count) {
    throw new RangeError(`Row range [${start}, ${end}) is outside the ${count} source rows`);
  }
  if (!Number.isSafeInteger(targetRow) || targetRow < 0) throw new RangeError(`Invalid target row ${targetRow}`);
  if (anchor.length !== 3 || !anchor.every(value => Number.isFinite(value))) {
    throw new RangeError('Gaussian anchor must be three finite float64 values');
  }
  if (sh.degree < degree || sh.bands.length < degree || sh.bands.some((band, index) => band.length !== (2 * index + 3) ** 2)) {
    throw new RangeError(`SH rotation of degree ${sh.degree} cannot rotate degree-${degree} rows`);
  }
  const rows = targetRow + end;
  const basis = target.shBasisCount;
  const harmonics = target.sphericalHarmonics;
  if (target.positions.length < rows * 3 || target.scales.length < rows * 3 || target.rotations.length < rows * 4
    || !BASIS_COUNTS.includes(basis) || basis < sourceBasis
    || (harmonics === undefined ? basis !== 0 : harmonics.length < rows * basis * 3)) {
    throw new RangeError(`Gaussian target cannot hold rows up to ${rows} with ${sourceBasis} SH bases per row`);
  }
}
