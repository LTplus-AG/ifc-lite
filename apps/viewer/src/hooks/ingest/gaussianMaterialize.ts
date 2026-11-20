// SPDX-License-Identifier: MPL-2.0
import { materializeToDataTable, type ChunkDataPool, type ChunkSource, type DataTable } from '@playcanvas/splat-transform';

/** The upstream layers a Gaussian capture must offer; the only ones materialized. */
export const GAUSSIAN_LAYERS = ['position', 'geometric', 'color'] as const;
const LAYERS = new Set(GAUSSIAN_LAYERS);

// SplatTransform 3.10 clamped true opacity to [1e-6, 1 - 1e-6]; this is the logit
// of the upper bound, and its negation the lower one (equal in f32).
const SATURATED_LOGIT = Math.log((1 - 1e-6) / 1e-6);

/**
 * Materialize the admitted Gaussian layers. Since 3.11 every reader keeps true
 * opacity and the table maps it to a logit that is +/-Infinity at exactly 1 and 0
 * (a `.splat` alpha of 255 or 0, or an extreme PLY logit whose f32 opacity
 * rounds to 1 or 0). Those saturated values are written as the finite
 * logits 3.10 decoded them to (#10613); NaN is left for validation to reject.
 */
export async function materializeGaussianLayers(source: ChunkSource, pool: ChunkDataPool): Promise<DataTable> {
  const table = await materializeToDataTable(source, pool, LAYERS);
  const opacity = table.columns.find(column => column.name === 'opacity')?.data;
  if (opacity) for (let i = 0; i < opacity.length; i++) {
    if (opacity[i] === Infinity || opacity[i] === -Infinity) opacity[i] = Math.sign(opacity[i]) * SATURATED_LOGIT;
  }
  return table;
}
