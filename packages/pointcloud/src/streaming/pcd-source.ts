/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PCD (PCL) streaming source — whole-file decode, single chunk.
 *
 * Like PLY, PCD isn't an octree format. The decoder lives in
 * `formats/pcd.ts` and handles ASCII / binary / binary_compressed
 * (LZF). For files past the 25M-point soft cap, `streamPointCloud`
 * applies stride downsampling on the way out.
 */

import type { DecodedPointChunk } from '../types.js';
import { decodePcd } from '../formats/pcd.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

export class PcdStreamingSource implements StreamingPointSource {
  private blob: Blob;
  private downsample: DownsampleHint;
  private label?: string;
  private chunk: DecodedPointChunk | null = null;
  private served = false;

  constructor(blob: Blob, options: { label?: string; downsample?: DownsampleHint } = {}) {
    this.blob = blob;
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    abortIfAborted(signal);
    const buf = await this.blob.arrayBuffer();
    abortIfAborted(signal);
    const decoded = decodePcd(new Uint8Array(buf));
    this.chunk = applyStride(decoded, this.downsample.stride);
    return {
      totalPointCount: this.chunk.pointCount,
      bbox: this.chunk.bbox,
      hasColor: !!this.chunk.colors,
      hasClassification: !!this.chunk.classifications,
      hasIntensity: !!this.chunk.intensities,
      label: this.label,
    };
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!this.chunk || this.served) return null;
    void maxPoints;
    this.served = true;
    return this.chunk;
  }

  close(): void {
    this.chunk = null;
    this.served = false;
  }
}

function applyStride(chunk: DecodedPointChunk, stride: number): DecodedPointChunk {
  const s = Math.max(1, stride | 0);
  if (s === 1) return chunk;
  const newCount = Math.ceil(chunk.pointCount / s);
  const positions = new Float32Array(newCount * 3);
  const colors = chunk.colors ? new Float32Array(newCount * 3) : undefined;
  let dst = 0;
  for (let i = 0; i < chunk.pointCount; i += s) {
    positions[dst * 3] = chunk.positions[i * 3];
    positions[dst * 3 + 1] = chunk.positions[i * 3 + 1];
    positions[dst * 3 + 2] = chunk.positions[i * 3 + 2];
    if (colors && chunk.colors) {
      colors[dst * 3] = chunk.colors[i * 3];
      colors[dst * 3 + 1] = chunk.colors[i * 3 + 1];
      colors[dst * 3 + 2] = chunk.colors[i * 3 + 2];
    }
    dst++;
  }
  return {
    positions,
    colors,
    pointCount: newCount,
    bbox: chunk.bbox,
  };
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
