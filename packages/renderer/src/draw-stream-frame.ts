/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame-side glue for the draw stream (draw-stream.ts): the renderer's
 * config and stream lifetime, when the stream may take over (the batch set
 * has settled, so a streaming load keeps the legacy path instead of
 * rebuilding nodes every frame), and which batches qualify.
 */
import type { BatchedMesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import { DrawStream, type StreamFrameInputs, type StreamFrameStats } from './draw-stream.js';
import { DEFAULT_DRAW_STREAM_CONFIG, drawStreamUsesHighlightIndex, type DrawStreamConfig } from './draw-stream-config.js';
import { batchEntities } from './batch-entities.js';
import { batchEntityIdAnchor, batchHasColorOverride, packOverrideParams } from './entity-color-table.js';
import { shouldRouteBatchTransparent } from './overlay-routing.js';

export interface StreamEligibilityInputs {
  visibility: (b: BatchedMesh) => unknown;
  alpha: (b: BatchedMesh) => number;
  colorOverrides: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  colorOverrideGen: number;
  emphasize: boolean;
  xrayActive: boolean;
  /** Every CPU mesh piece (HLOD proxy source). */
  forEachPiece?: (visit: (m: MeshData) => void) => void;
  requestRender?: () => void;
}

const keyHashes = new WeakMap<BatchedMesh, number>();
/** Stable 32-bit hash of a batch's bucket key (FNV-1a), cached per batch. */
function keyHash(b: BatchedMesh): number {
  let h = keyHashes.get(b);
  if (h === undefined) {
    h = 0x811c9dc5;
    for (let i = 0; i < b.colorKey.length; i++) h = Math.imul(h ^ b.colorKey.charCodeAt(i), 0x01000193) >>> 0;
    keyHashes.set(b, h);
  }
  return h;
}

class DrawStreamGate {
  private signature = '';
  private changedAt = 0;
  private readonly scratch = new Uint32Array(4);

  /**
   * O(batches) signature of the batch set and the scene's geometry revision
   * (a model move or edit); the stream engages once it held for `settleMs`.
   */
  settled(batches: readonly BatchedMesh[], config: DrawStreamConfig, revision: number): boolean {
    let sum = 0, resident = 0;
    for (const b of batches) { sum = (sum + keyHash(b)) % 4294967296; if (b.gpuResident !== false) resident++; }
    // Residency is NOT part of the geometry signature. Over the GPU budget, a camera move
    // evicts offscreen batches; when that changed the signature, the stream went back to legacy,
    // waited `settleMs` and rebuilt its arena (a GB-scale GPU copy) and HLOD: 0.2-2 s frames on
    // small-unique 1M. Residency now only changes membership (the epoch below), and evicted batches
    // the arena already copied keep drawing from the arena. Batches hash by bucket key, not id: a
    // batch restored from eviction is a new object with a new id but the same geometry.
    const sig = `${batches.length}:${sum}:${revision}`;
    this.resident = resident;
    const now = performance.now();
    if (sig !== this.signature) { this.signature = sig; this.changedAt = now; }
    return now - this.changedAt >= config.settleMs;
  }

  private resident = 0;

  sync(stream: DrawStream, batches: readonly BatchedMesh[], epoch: string, cell: number, inputs: StreamEligibilityInputs): void {
    const nodeCell = stream.config.nodeCell > 0 ? stream.config.nodeCell : cell;
    stream.sync(batches, this.signature, `${this.signature}|${epoch}|r${this.resident}`, nodeCell, (b) => {
      // X-Ray splits batches per alpha group (#4129): keep the whole legacy machinery.
      if (inputs.xrayActive) return null;
      if (inputs.visibility(b) !== 'all') return null;
      const alpha = inputs.alpha(b);
      if (alpha < 0.99) return null;
      if (shouldRouteBatchTransparent(alpha, batchEntities(b), inputs.colorOverrides)) return null;
      const anchor = batchEntityIdAnchor(b);
      const painted = batchHasColorOverride(b, inputs.colorOverrides, inputs.colorOverrideGen);
      packOverrideParams(this.scratch, anchor, painted, inputs.emphasize);
      return { alpha, anchor, overrideBits: this.scratch[1]! };
    }, inputs.forEachPiece, inputs.requestRender);
  }
}

/** The renderer's side of the draw stream: config, lifetime, and the per-frame engage and encode. */
export class RendererDrawStream {
  private config: Readonly<DrawStreamConfig> = DEFAULT_DRAW_STREAM_CONFIG;
  private stream: DrawStream | null = null;
  private active: DrawStream | null = null;
  private readonly gate = new DrawStreamGate();

  /** Whether the stream may engage at all (callers skip building its frame inputs otherwise). */
  get enabled(): boolean { return this.config.stream; }

  /** Replace the config; the current stream is dropped and rebuilds on the next settled frame. */
  configure(config: Readonly<DrawStreamConfig>): void {
    this.config = { ...config };
    this.destroy();
  }

  /** Whether batch highlight resync resolves ids through the entity -> batch index. */
  get highlightIndex(): boolean { return drawStreamUsesHighlightIndex(this.config); }

  /** Whether the stream draws this frame (set by `begin`). */
  get engaged(): boolean { return this.active !== null; }

  /**
   * Start a frame. Once the batch set has settled, sync the stream and return
   * the batches the per-batch loop still draws; otherwise return every batch.
   */
  begin(device: GPUDevice, pipeline: RenderPipeline, batches: readonly BatchedMesh[], revision: number, epoch: string, cell: number, inputs: StreamEligibilityInputs): readonly BatchedMesh[] {
    this.active = null;
    if (!this.config.stream) return batches;
    // Unsettled (a load, an unload, a model move): free the old arena, proxies and worker now.
    if (!this.gate.settled(batches, this.config, revision)) { this.destroy(); return batches; }
    const stream = (this.stream ??= new DrawStream(device, pipeline, this.config));
    this.gate.sync(stream, batches, epoch, cell, inputs);
    this.active = stream;
    return stream.legacy;
  }

  /**
   * Draw the engaged stream into the opaque pass (call only when `engaged`).
   * `drawn` sees every batch drawn, so the residency budget keeps it warm.
   */
  encode(frameUniforms: Float32Array, rte: RelativeToEyeFrame, inputs: StreamFrameInputs, drawn: (b: BatchedMesh) => void): StreamFrameStats {
    const stream = this.active;
    if (!stream) throw new Error('RendererDrawStream.encode: the stream did not engage this frame');
    stream.prepareFrame(frameUniforms, rte);
    return stream.encode(inputs, drawn);
  }

  /** Drop the stream's GPU records, arenas, bundles and proxies (config change, device loss, teardown). */
  destroy(): void {
    this.stream?.destroy();
    this.stream = null;
    this.active = null;
  }
}
