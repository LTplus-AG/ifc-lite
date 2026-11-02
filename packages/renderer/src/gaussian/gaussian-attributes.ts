/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Upstream-decoded PLY-space columns; scale/opacity retain log/logit encoding. */
export interface GaussianAttributeSource {
  count: number;
  shDegree: 0 | 1 | 2 | 3;
  columns: Readonly<Record<string, Float32Array>>;
}

/**
 * CPU-owned, source-local arrays matching upstream SplatSource. No axis, unit,
 * placement or RTC transform is implicit. Uploaders borrow these arrays and own
 * their GPU allocations; normalization never detaches or mutates source buffers.
 */
export interface NormalizedGaussianAttributes {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  /** Unit quaternions in WXYZ order. */
  rotations: Float32Array;
  /** Unclamped linear RGBA radiance, alpha one; opacity is separate. */
  colors: Float32Array;
  opacities: Float32Array;
  /** Row-major, basis-major RGB triplets, excluding DC. */
  sphericalHarmonics: Float32Array;
  sphericalHarmonicsDegree: 0 | 1 | 2 | 3;
}

const SH_DC = 0.28209479177387814;

/** Normalize once at the render boundary; this does not confer rendering readiness. */
export function normalizeGaussianAttributes(source: GaussianAttributeSource): NormalizedGaussianAttributes {
  const { count, shDegree, columns } = source;
  if (!Number.isSafeInteger(count) || count < 0 || ![0, 1, 2, 3].includes(shDegree)) {
    throw new Error('Invalid Gaussian count or SH degree');
  }
  const basisCount = (shDegree + 1) ** 2 - 1;
  const names = ['x', 'y', 'z', 'opacity', ...[0, 1, 2].map(i => `scale_${i}`),
    ...[0, 1, 2, 3].map(i => `rot_${i}`), ...[0, 1, 2].map(i => `f_dc_${i}`),
    ...Array.from({ length: basisCount * 3 }, (_, i) => `f_rest_${i}`)];
  for (const name of names) {
    const column = columns[name];
    if (!(column instanceof Float32Array) || column.length !== count) {
      throw new Error(`Invalid Gaussian column ${name}: expected ${count} float32 values`);
    }
    for (const value of column) if (!Number.isFinite(value)) throw new Error(`Non-finite Gaussian column ${name}`);
  }
  for (const name of Object.keys(columns)) {
    if (name.startsWith('f_rest_') && !names.includes(name)) throw new Error(`Gaussian SH degree disagrees with ${name}`);
  }
  const result: NormalizedGaussianAttributes = {
    count, positions: new Float32Array(count * 3), scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4), colors: new Float32Array(count * 4),
    opacities: new Float32Array(count), sphericalHarmonics: new Float32Array(count * basisCount * 3),
    sphericalHarmonicsDegree: shDegree,
  };
  for (let row = 0; row < count; row++) {
    for (let axis = 0; axis < 3; axis++) {
      result.positions[row * 3 + axis] = columns[['x', 'y', 'z'][axis]][row];
      const scale = Math.fround(Math.exp(columns[`scale_${axis}`][row]));
      const variance = Math.fround(scale * scale);
      if (!(variance > 0) || !Number.isFinite(variance)) throw new Error(`Gaussian covariance is not representable at row ${row}`);
      result.scales[row * 3 + axis] = scale;
      result.colors[row * 4 + axis] = 0.5 + SH_DC * columns[`f_dc_${axis}`][row];
      for (let basis = 0; basis < basisCount; basis++) {
        result.sphericalHarmonics[(row * basisCount + basis) * 3 + axis] = columns[`f_rest_${axis * basisCount + basis}`][row];
      }
    }
    result.colors[row * 4 + 3] = 1;
    const norm = Math.hypot(...[0, 1, 2, 3].map(i => columns[`rot_${i}`][row]));
    if (!(norm > 0)) throw new Error(`Zero Gaussian quaternion at row ${row}`);
    for (let axis = 0; axis < 4; axis++) result.rotations[row * 4 + axis] = columns[`rot_${axis}`][row] / norm;
    const logit = columns.opacity[row];
    const exponential = Math.exp(-Math.abs(logit));
    result.opacities[row] = logit >= 0 ? 1 / (1 + exponential) : exponential / (1 + exponential);
  }
  return result;
}
