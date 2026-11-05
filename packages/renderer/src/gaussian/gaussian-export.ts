/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { normalizeGaussianAttributes, type GaussianAttributeSource } from './gaussian-attributes.js';

/** Bounded, CPU-only export batches. Positions stay f64 in the destination
 * frame; log-scale, logit opacity and channel-major SH retain PLY semantics.
 * Uses the renderer's covariance/SH transform, never its quantized GPU rows. */
export async function* positionedGaussianChunks(
  source: GaussianAttributeSource, matrix: readonly number[],
): AsyncGenerator<Readonly<Record<string, Float32Array | Float64Array>>> {
  if (!Number.isSafeInteger(source.count) || source.count < 1) throw new Error('Invalid Gaussian export count.');
  const { decomposeSimilarity, shRotationFor, transformGaussianRows } = await import('./gaussian-placement.js');
  const placement = decomposeSimilarity(matrix);
  const sh = shRotationFor(placement, source.shDegree);
  const basis = (source.shDegree + 1) ** 2 - 1;
  for (let start = 0; start < source.count; start += 8192) {
    const count = Math.min(8192, source.count - start);
    const columns = Object.fromEntries(Object.entries(source.columns).map(([key, values]) => [key, values.slice(start, start + count)]));
    const input = normalizeGaussianAttributes({ count, shDegree: source.shDegree, columns });
    const target = { positions: new Float32Array(count * 3), scales: new Float32Array(count * 3),
      rotations: new Float32Array(count * 4), sphericalHarmonics: new Float32Array(count * basis * 3), shBasisCount: basis };
    transformGaussianRows(input, placement, sh, placement.translation, target, 0, 0, count);
    const positions = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
    for (let row = 0; row < count; row++) {
      for (let axis = 0; axis < 3; axis++) {
        positions[axis][row] = placement.translation[axis] + placement.scale * (
          placement.rotation[axis] * input.positions[row * 3]
          + placement.rotation[3 + axis] * input.positions[row * 3 + 1]
          + placement.rotation[6 + axis] * input.positions[row * 3 + 2]);
        if (!Number.isFinite(positions[axis][row])) throw new Error('Export position overflow.');
        // Retain authored log scales rather than an exp/log round-trip.
        columns[`scale_${axis}`][row] += Math.log(placement.scale);
        for (let b = 0; b < basis; b++) columns[`f_rest_${axis * basis + b}`][row] = target.sphericalHarmonics[(row * basis + b) * 3 + axis];
      }
      for (let axis = 0; axis < 4; axis++) columns[`rot_${axis}`][row] = target.rotations[row * 4 + axis];
    }
    yield { ...columns, x: positions[0], y: positions[1], z: positions[2] };
  }
}
