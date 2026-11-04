// SPDX-License-Identifier: MPL-2.0
import { createChunkDataPool, MemoryReadFileSystem, readPly, readSplat,
  materializeToDataTable, type ChunkSource } from '@playcanvas/splat-transform';
import { inspectGaussianDecodeAdmission } from './gaussianAdmission.js';
import { validateGaussianDecoded, type GaussianDecoded } from './gaussianDecoded.js';
import { rebaseGaussianPositions } from './gaussianPositionRebase.js';

/** Worker-only upstream decoder. This does not grant admission to the renderer. */
export async function decodeGaussianFile(file: File): Promise<GaussianDecoded> {
  const admission = await inspectGaussianDecodeAdmission(file, await file.slice(0, 4096).arrayBuffer());
  if (admission.kind !== 'capture') {
    throw new Error(admission.kind === 'invalid' ? admission.reason : 'Not a Gaussian capture.');
  }
  const fs = new MemoryReadFileSystem();
  const bytes = new Uint8Array(await file.arrayBuffer());
  fs.set('capture', bytes);
  const input = await fs.createSource('capture');
  // Upstream allocates record scratch outside the pool's retained-byte cap.
  // Include every scalar (even unmaterialized extras) and never reserve absent rows.
  const scratchBytes = 16 * 1024 * 1024;
  const chunkSize = Math.min(65_536, admission.count, Math.floor(scratchBytes / admission.recordStride));
  const pool = createChunkDataPool({ chunkSize, maxPooledBytes: scratchBytes });
  let source: ChunkSource | undefined;
  try {
    source = await (admission.format === 'splat' ? readSplat(input, pool) : readPly(input, pool));
    const meta = source.meta;
    if (meta.numGaussians !== admission.count || meta.shBands !== admission.shDegree
      || meta.numLods !== 1 || meta.model !== 'default'
      || !['position', 'geometric', 'color'].every(layer => meta.availableLayers.has(layer as 'position' | 'geometric' | 'color'))) {
      throw new Error('Unsupported or inconsistent decoded Gaussian schema.');
    }
    // Only admitted Gaussian layers allocate output; unrelated PLY extras are
    // never materialized. Position locals are rebased before f32 narrowing.
    const table = await materializeToDataTable(source, pool, new Set(['position', 'geometric', 'color']));
    const position = rebaseGaussianPositions(bytes, admission.format, table.numRows, admission.recordStride, table.columns);
    return validateGaussianDecoded(table.numRows, meta.shBands, table.columns, position);
  } finally {
    try {
      if (source) await source.close();
      else await input.close();
    } finally { pool.destroy(); }
  }
}
