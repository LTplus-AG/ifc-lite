/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Batches whose index buffer holds several runs that each decide their own
 * LOD (compact pages, `compact-lod.ts`).
 *
 * A bucket batch decides contribution culling and LOD1 from its own box. A
 * compact page holds meshes the bucket path would have spread over several
 * buckets, so each run of the page (a part) carries the box of the bucket it
 * stands in for and its ranges in the page's two index buffers. The draw loop
 * judges every part on that box, as it judges a bucket batch, and draws
 * consecutive parts that chose the same buffer with one call.
 */

/** One run of a batch's index buffers (counts and starts in indices of the batch's `indexFormat`). */
export interface LodPart {
  /** The box the decision is taken on: the bucket's this part stands in for (shared between pages). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  lod0Start: number;
  lod0Count: number;
  /** Whether the part has a LOD1 range (`lod1Start`, `lod1Count` in `lod1IndexBuffer`); without one it always draws
   *  full detail. A LOD1 range may be empty: every triangle of the part collapsed, so at LOD distance it draws nothing. */
  lod1: boolean;
  lod1Start: number;
  lod1Count: number;
}

/** What a part draws this frame. */
export const PartDraw = { Skip: 0, Lod0: 1, Lod1: 2 } as const;
export type PartDraw = typeof PartDraw[keyof typeof PartDraw];

/**
 * Decide a part from its box's projected radius in CSS px: culled below
 * `contribPx`, LOD1 below `lodPx` when it has one (the order the draw loop
 * applies to a bucket batch); either threshold 0 is off.
 */
export function partDraw(part: LodPart, px: number, contribPx: number, lodPx: number): PartDraw {
  if (contribPx > 0 && px < contribPx) return PartDraw.Skip;
  return lodPx > 0 && px < lodPx && part.lod1 ? PartDraw.Lod1 : PartDraw.Lod0;
}

interface PartsBatch {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexFormat?: GPUIndexFormat;
  lod1IndexBuffer?: GPUBuffer;
  /** The records LOD1 ranges index, when not `vertexBuffer`. */
  lod1VertexBuffer?: GPUBuffer;
}

/**
 * Draw `parts` of `batch` (vertex buffer and bind group already set) as `choose` decides.
 * Returns draw calls * 2, plus 1 when a part drew its LOD1 range (a number: the per-batch draw allocates nothing).
 */
export function drawLodParts(
  pass: Pick<GPURenderPassEncoder, 'setVertexBuffer' | 'setIndexBuffer' | 'drawIndexed'>,
  batch: PartsBatch,
  parts: readonly LodPart[],
  choose: (part: LodPart) => PartDraw,
): number {
  const format = batch.indexFormat ?? 'uint32';
  let bound: PartDraw = PartDraw.Skip;
  let run: PartDraw = PartDraw.Skip, start = 0, count = 0, draws = 0, lod1 = false;
  const flush = (): void => {
    if (run === PartDraw.Skip) return; // runs start non-empty (empty ranges are skipped below)
    if (bound !== run) {
      // The caller bound `vertexBuffer`: a LOD1 run over records of its own binds those, and a later LOD0 run binds it back.
      if (batch.lod1VertexBuffer && (run === PartDraw.Lod1 || bound === PartDraw.Lod1)) pass.setVertexBuffer(0, run === PartDraw.Lod1 ? batch.lod1VertexBuffer : batch.vertexBuffer);
      pass.setIndexBuffer(run === PartDraw.Lod1 ? batch.lod1IndexBuffer! : batch.indexBuffer, format);
      bound = run;
    }
    pass.drawIndexed(count, 1, start);
    draws++;
    if (run === PartDraw.Lod1) lod1 = true;
  };
  for (const part of parts) {
    const draw = choose(part);
    if (draw === PartDraw.Skip) continue;
    const at = draw === PartDraw.Lod1 ? part.lod1Start : part.lod0Start;
    const n = draw === PartDraw.Lod1 ? part.lod1Count : part.lod0Count;
    if (n === 0) { if (draw === PartDraw.Lod1) lod1 = true; continue; } // an empty LOD1 range: drawn at LOD1, as nothing
    if (draw === run && start + count === at) { count += n; continue; }
    flush();
    run = draw; start = at; count = n;
  }
  flush();
  return draws * 2 + (lod1 ? 1 : 0);
}

/**
 * Bind and draw a batch's indices (vertex buffer and bind group already set): its parts as `choose`
 * decides; without parts, its LOD1 range when `lod1`, else every index. Returns draw calls * 2, plus 1
 * when a LOD1 range was drawn.
 */
export function drawBatchIndices(
  pass: Pick<GPURenderPassEncoder, 'setVertexBuffer' | 'setIndexBuffer' | 'drawIndexed'>,
  batch: PartsBatch & { indexCount: number; lod1IndexCount?: number; lodParts?: readonly LodPart[] },
  lod1: boolean,
  choose: (part: LodPart) => PartDraw,
): number {
  if (batch.lodParts) return drawLodParts(pass, batch, batch.lodParts, choose);
  if (lod1) {
    pass.setIndexBuffer(batch.lod1IndexBuffer!, 'uint32');
    pass.drawIndexed(batch.lod1IndexCount!);
  } else {
    pass.setIndexBuffer(batch.indexBuffer, batch.indexFormat ?? 'uint32');
    pass.drawIndexed(batch.indexCount);
  }
  return lod1 ? 3 : 2;
}
