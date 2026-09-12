/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLY streaming source.
 *
 * `open()` scans header and bounds in fixed-size byte windows without
 * allocating point channels. `next()` decodes directly into a bounded output
 * chunk and skips unretained stride rows before allocation. A cap probe and
 * its downsampled reopen therefore never materialise full-count XYZ/RGB/normal
 * arrays.
 */

import { inspectPlyVertex, parsePlyHeader } from '../formats/ply.js';
import type { DecodedPointChunk } from '../types.js';
import { PlyChunkReader, scanPlyBounds, type PlyStreamInstrumentation } from './ply-stream-decode.js';
import { normalizePointStride } from './stride.js';
import type { DownsampleHint, PointSourceInfo, StreamingPointSource } from './types.js';

const HEADER_BYTES = 65_536;
const HEADER_DECODER = new TextDecoder();

export class PlyStreamingSource implements StreamingPointSource {
  private readonly downsample: DownsampleHint;
  private readonly label?: string;
  private readonly originOffset?: readonly [number, number, number];
  private readonly instrumentation?: PlyStreamInstrumentation;
  private reader: PlyChunkReader | null = null;

  constructor(
    private readonly blob: Blob,
    options: {
      label?: string;
      downsample?: DownsampleHint;
      originOffset?: readonly [number, number, number];
      /** @internal Regression instrumentation; production callers omit it. */
      instrumentation?: PlyStreamInstrumentation;
    } = {},
  ) {
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
    this.originOffset = options.originOffset;
    this.instrumentation = options.instrumentation;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    this.close();
    abortIfAborted(signal);
    const headerBytes = new Uint8Array(await this.blob.slice(0, Math.min(HEADER_BYTES, this.blob.size)).arrayBuffer());
    abortIfAborted(signal);
    if (headerBytes.byteLength === HEADER_BYTES && !hasCompleteHeader(headerBytes)) {
      throw new Error(`PLY: header exceeds the bounded ${HEADER_BYTES}-byte streaming limit`);
    }
    const header = parsePlyHeader(headerBytes);
    const layout = inspectPlyVertex(header);
    const bbox = await scanPlyBounds(this.blob, header, layout, this.originOffset, signal);
    const stride = normalizePointStride(this.downsample.stride);
    this.reader = new PlyChunkReader(this.blob, header, layout, stride, this.originOffset, this.instrumentation);
    const properties = layout.vertex.properties;
    const has = (...names: string[]) => properties.some((property) => names.includes(property.name));
    return {
      totalPointCount: Math.ceil(layout.vertex.count / stride),
      bbox,
      hasColor: has('red', 'r') && has('green', 'g') && has('blue', 'b'),
      hasClassification: false,
      hasIntensity: has('intensity', 'scalar_Intensity'),
      label: this.label,
    };
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    if (!this.reader) return null;
    return this.reader.next(maxPoints, signal);
  }

  close(): void {
    this.reader = null;
  }
}

function hasCompleteHeader(bytes: Uint8Array): boolean {
  return /(?:^|\n)[\t ]*end_header[\t ]*\r?\n/.test(HEADER_DECODER.decode(bytes));
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
