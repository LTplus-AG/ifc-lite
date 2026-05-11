/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PTS / XYZ streaming source — whole-file ASCII decode.
 *
 * ASCII formats don't support random-access seek by point index, so
 * we read the whole blob, decode once, and serve as a single chunk.
 * Memory is still bounded by the host's 25M-point cap via the
 * `stride` downsample applied here.
 *
 * The whole-file approach is simpler and matches PLY's behaviour;
 * for files past the cap we apply stride downsampling on the way
 * out so the GPU upload stays bounded.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  decodeAsciiPoints,
  type AsciiPointsFormat,
} from '../formats/ascii-points.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

export class AsciiPointsStreamingSource implements StreamingPointSource {
  private blob: Blob;
  private format: AsciiPointsFormat;
  private downsample: DownsampleHint;
  private label?: string;
  private chunk: DecodedPointChunk | null = null;
  private served = false;

  constructor(
    blob: Blob,
    format: AsciiPointsFormat,
    options: { label?: string; downsample?: DownsampleHint } = {},
  ) {
    this.blob = blob;
    this.format = format;
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    abortIfAborted(signal);
    const buf = await this.blob.arrayBuffer();
    abortIfAborted(signal);
    const bytes = new Uint8Array(buf);
    const fullChunk = decodeAsciiPoints(bytes, this.format);
    this.chunk = applyStride(fullChunk, this.downsample.stride);
    return {
      totalPointCount: this.chunk.pointCount,
      bbox: this.chunk.bbox,
      hasColor: !!this.chunk.colors,
      hasClassification: false,
      hasIntensity: !!this.chunk.intensities,
      label: this.label,
    };
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!this.chunk || this.served) return null;
    void maxPoints; // Whole-file decode: ignore chunk-size hint.
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
  const intensities = chunk.intensities ? new Uint16Array(newCount) : undefined;
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
    if (intensities && chunk.intensities) {
      intensities[dst] = chunk.intensities[i];
    }
    dst++;
  }
  return {
    positions,
    colors,
    intensities,
    pointCount: newCount,
    bbox: chunk.bbox,
  };
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
