// SPDX-License-Identifier: MPL-2.0
import { GAUSSIAN_LAUNCH_LIMITS } from './gaussianLaunchLimits.js';

/** Canonical upstream PLY-space channels. Placement is a separate, explicit step. */
export interface GaussianDecoded {
  count: number;
  shDegree: 0 | 1 | 2 | 3;
  columns: Record<string, Float32Array>;
  /** Bounds of centers, not a claim about the infinite Gaussian support. */
  centerBounds: { min: [number, number, number]; max: [number, number, number] };
  /** Source-space centre removed in f64 before narrowing position columns. */
  decodeOrigin: readonly [number, number, number];
}

const BASE = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
const SH_COUNTS = [0, 9, 24, 45] as const;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

/** #8565: reject invalid decoded data before any GPU allocation or publication.
 * Upstream preserves non-finite input; header admission alone cannot establish
 * this invariant. Keep log-scale/logit and SH values intact for upstream rendering.
 */
export function validateGaussianDecoded(
  count: number,
  shDegree: number,
  input: readonly { name: string; data: ArrayLike<number> }[],
  source?: { origin: readonly [number, number, number]; bounds: GaussianDecoded['centerBounds'] },
): GaussianDecoded {
  if (!Number.isSafeInteger(count) || count < 1 || count > GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats
    || !Number.isInteger(shDegree) || shDegree < 0 || shDegree > GAUSSIAN_LAUNCH_LIMITS.maxShDegree) {
    throw new Error('Invalid decoded Gaussian dimensions.');
  }
  const degree = shDegree as 0 | 1 | 2 | 3;
  const names = [...BASE, ...Array.from({ length: SH_COUNTS[degree] }, (_, i) => `f_rest_${i}`)];
  if (count * names.length * 4 > MAX_DECODED_BYTES) throw new Error('Decoded Gaussian allocation limit exceeded.');
  const byName = new Map<string, ArrayLike<number>>();
  for (const column of input) {
    if (byName.has(column.name)) throw new Error('Duplicate decoded Gaussian channel.');
    byName.set(column.name, column.data);
  }
  const columns: Record<string, Float32Array> = Object.create(null);
  for (const name of names) {
    const values = byName.get(name);
    if (!values || values.length !== count) throw new Error(`Invalid decoded Gaussian channel: ${name}.`);
    const output = values instanceof Float32Array ? values : Float32Array.from(values);
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(output[i])) throw new Error(`Non-finite decoded Gaussian channel: ${name}.`);
    }
    columns[name] = output;
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const norm = Math.hypot(columns.rot_0[i], columns.rot_1[i], columns.rot_2[i], columns.rot_3[i]);
    if (!(norm > 0)) throw new Error('Degenerate Gaussian rotation.');
    for (let axis = 0; axis < 3; axis++) {
      // Finite log scale can still overflow/underflow when the renderer expands
      // it into float32 covariance. Reject instead of silently clipping geometry.
      const variance = Math.fround(Math.exp(2 * columns[`scale_${axis}`][i]));
      if (!Number.isFinite(variance) || variance <= 0) throw new Error('Unrepresentable Gaussian covariance.');
      const value = columns[['x', 'y', 'z'][axis]][i];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const centerBounds = source?.bounds ?? { min, max };
  const decodeOrigin = source?.origin ?? centerBounds.min.map((value, axis) => value / 2 + centerBounds.max[axis] / 2) as [number, number, number];
  if (!source) for (const name of ['x', 'y', 'z'] as const) {
    const axis = ['x', 'y', 'z'].indexOf(name);
    for (let i = 0; i < count; i++) columns[name][i] -= decodeOrigin[axis];
  }
  return { count, shDegree: degree, columns, centerBounds, decodeOrigin };
}
