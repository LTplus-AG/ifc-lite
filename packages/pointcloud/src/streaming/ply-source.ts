/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLY streaming source — whole-file decode, single chunk.
 *
 * PLY isn't an octree format, so we don't get incremental visibility
 * benefits from chunked decode. Reading the whole file once and emitting
 * one chunk is simpler and correct.  Memory is still bounded by
 * `streamPointCloud`'s 25M-point cap — for files past that, the stride
 * downsample applies on the way out.
 */

import type { DecodedPointChunk } from '../types.js';
import { decodePly, parsePlyHeader } from '../formats/ply.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

export class PlyStreamingSource implements StreamingPointSource {
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
    const bytes = new Uint8Array(buf);
    // Header probe first — gives us the count + capabilities so the
    // host can decide on downsampling stride before the full decode.
    const header = parsePlyHeader(bytes);
    const vertex = header.elements.find((e) => e.name === 'vertex');
    if (!vertex) throw new Error('PLY: no vertex element');
    const hasRgb =
      !!vertex.properties.find((p) => p.name === 'red' || p.name === 'r')
      && !!vertex.properties.find((p) => p.name === 'green' || p.name === 'g')
      && !!vertex.properties.find((p) => p.name === 'blue' || p.name === 'b');
    const hasIntensity = !!vertex.properties.find(
      (p) => p.name === 'intensity' || p.name === 'scalar_Intensity',
    );

    // Decode now (we already have all bytes). The cost is amortised over
    // the next() call — caller perceives no extra latency.
    const fullChunk = decodePly(bytes);
    this.chunk = applyStride(fullChunk, this.downsample.stride);
    return {
      totalPointCount: this.chunk.pointCount,
      bbox: this.chunk.bbox,
      hasColor: hasRgb,
      hasClassification: false,
      hasIntensity,
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
  const classifications = chunk.classifications ? new Uint8Array(newCount) : undefined;
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
    if (classifications && chunk.classifications) {
      classifications[dst] = chunk.classifications[i];
    }
    if (intensities && chunk.intensities) {
      intensities[dst] = chunk.intensities[i];
    }
    dst++;
  }
  return {
    positions,
    colors,
    classifications,
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
