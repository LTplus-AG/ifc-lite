/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DecodedPointChunk, StreamingPointSource } from '@ifc-lite/pointcloud';
import { PositionedPly, type PlyColumns } from './ply';

/** Matrix maps source-native decode-local Z-up points into project Z-up. */
export function positionedScanColumns(chunk: DecodedPointChunk, matrix: readonly number[]): PlyColumns {
  const positions = [new Float64Array(chunk.pointCount), new Float64Array(chunk.pointCount), new Float64Array(chunk.pointCount)];
  const normals = chunk.normals && [new Float32Array(chunk.pointCount), new Float32Array(chunk.pointCount), new Float32Array(chunk.pointCount)];
  if (chunk.normalState === 'invalid') throw new Error('The scan contains invalid normals; export refused.');
  // Inverse-transpose of the linear transform, for normals (alignment can scale axes).
  const [a, b, c, d, e, f, g, h, i] = [matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9], matrix[2], matrix[6], matrix[10]];
  const cofactors = [e*i-f*h, f*g-d*i, d*h-e*g, c*h-b*i, a*i-c*g, b*g-a*h, b*f-c*e, c*d-a*f, a*e-b*d];
  const det = a * cofactors[0] + b * cofactors[1] + c * cofactors[2];
  if (!Number.isFinite(det) || det === 0) throw new Error('Singular scan placement.');
  for (let row = 0; row < chunk.pointCount; row++) {
    for (let axis = 0; axis < 3; axis++) positions[axis][row] = matrix[12 + axis]
      + matrix[axis] * chunk.positions[row * 3] + matrix[4 + axis] * chunk.positions[row * 3 + 1] + matrix[8 + axis] * chunk.positions[row * 3 + 2];
    if (normals && chunk.normals) {
      const n = [0, 1, 2].map(axis => (cofactors[axis * 3] * chunk.normals![row * 3]
        + cofactors[axis * 3 + 1] * chunk.normals![row * 3 + 1] + cofactors[axis * 3 + 2] * chunk.normals![row * 3 + 2]) / det);
      const length = Math.hypot(...n);
      if (!(length > 0 && Number.isFinite(length))) throw new Error('Invalid transformed scan normal.');
      for (let axis = 0; axis < 3; axis++) normals[axis][row] = n[axis] / length;
    }
  }
  const columns: Record<string, PlyColumns[string]> = { x: positions[0], y: positions[1], z: positions[2] };
  if (chunk.colors) for (const [axis, key] of ['red', 'green', 'blue'].entries()) columns[key] = Float32Array.from({ length: chunk.pointCount }, (_, row) => chunk.colors![row * 3 + axis]);
  if (normals) for (const [axis, key] of ['nx', 'ny', 'nz'].entries()) columns[key] = normals[axis];
  if (chunk.intensities) columns.intensity = chunk.intensities;
  if (chunk.classifications) columns.classification = chunk.classifications;
  return columns;
}

export async function exportPositionedScan(source: StreamingPointSource, matrix: readonly number[], signal: AbortSignal,
  progress: (count: number) => void): Promise<Blob> {
  const ply = new PositionedPly();
  let count = 0;
  try {
    signal.throwIfAborted();
    const info = await source.open(signal);
    if (info.totalPointCount * 24 > PositionedPly.maxBytes - 65536) throw new Error('Full-resolution positions exceed the 256 MiB browser export limit.');
    while (true) {
      signal.throwIfAborted();
      const chunk = await source.next(8192, signal);
      signal.throwIfAborted();
      if (!chunk) break;
      // Some existing decoders return their whole input despite maxPoints.
      for (let start = 0; start < chunk.pointCount; start += 8192) {
        signal.throwIfAborted();
        const end = Math.min(start + 8192, chunk.pointCount);
        const batch = { ...chunk, pointCount: end - start,
          positions: chunk.positions.subarray(start * 3, end * 3),
          colors: info.hasColor ? chunk.colors?.subarray(start * 3, end * 3) ?? new Float32Array((end-start)*3) : undefined,
          normals: chunk.normals?.subarray(start * 3, end * 3),
          intensities: info.hasIntensity ? chunk.intensities?.subarray(start, end) ?? new Uint16Array(end-start) : undefined,
          classifications: info.hasClassification ? chunk.classifications?.subarray(start, end) ?? new Uint8Array(end-start) : undefined };
        ply.add(positionedScanColumns(batch, matrix));
        progress(count += batch.pointCount);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    signal.throwIfAborted();
    return ply.finish();
  } finally { source.close(); }
}
