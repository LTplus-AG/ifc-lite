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
 * arrays, and `reopen()` re-targets stride and origin without a second scan.
 */

import { inspectPlyVertex, parsePlyHeader, type PlyHeader, type PlyVertexLayout } from '../formats/ply.js';
import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import { PlyChunkReader, scanPlyBounds, type PlyBoundsScan, type PlyStreamInstrumentation } from './ply-stream-decode.js';
import { normalizePointStride } from './stride.js';
import type { DownsampleHint, PointSourceInfo, PointSourceReopenOptions, StreamingPointSource } from './types.js';

const HEADER_BYTES = 65_536;
const HEADER_DECODER = new TextDecoder();

export class PlyStreamingSource implements StreamingPointSource {
  private downsample: DownsampleHint;
  private readonly label?: string;
  private originOffset?: readonly [number, number, number];
  private readonly instrumentation?: PlyStreamInstrumentation;
  private reader: PlyChunkReader | null = null;
  /** Header and body scan from the last open(), kept so reopen() need not read the file again. */
  private scanned: { header: PlyHeader; layout: PlyVertexLayout; scan: PlyBoundsScan } | null = null;

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
    const scan = await scanPlyBounds(this.blob, header, layout, signal);
    this.scanned = { header, layout, scan };
    return this.start();
  }

  /**
   * Restart from the first point at a new stride and origin. The bounds scan
   * does not depend on either, so this reuses the last open()'s scan instead
   * of reading the whole file again (#8777).
   */
  async reopen(options: PointSourceReopenOptions, signal?: AbortSignal): Promise<PointSourceInfo> {
    abortIfAborted(signal);
    this.downsample = { stride: options.stride };
    this.originOffset = options.originOffset;
    return this.scanned ? this.start() : this.open(signal);
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    if (!this.reader) return null;
    return this.reader.next(maxPoints, signal);
  }

  close(): void {
    this.reader = null;
    this.scanned = null;
  }

  private start(): PointSourceInfo {
    const { header, layout, scan } = this.scanned!;
    const stride = normalizePointStride(this.downsample.stride);
    this.reader = new PlyChunkReader(this.blob, header, layout, stride, this.originOffset,
      scan.normalState, scan.floatColorsUseByteRange, this.instrumentation);
    const properties = layout.vertex.properties;
    const has = (...names: string[]) => properties.some((property) => names.includes(property.name));
    return {
      totalPointCount: Math.ceil(layout.vertex.count / stride),
      bbox: offsetBounds(scan.bbox, this.originOffset),
      hasColor: has('red', 'r') && has('green', 'g') && has('blue', 'b'),
      hasClassification: has('classification'),
      hasIntensity: has('intensity', 'scalar_Intensity'),
      label: this.label,
    };
  }
}

/**
 * Subtracting a constant is monotonic in f64, so offsetting the raw bounds
 * equals scanning the offset coordinates.
 */
function offsetBounds(bbox: PointCloudBBox, origin?: readonly [number, number, number]): PointCloudBBox {
  if (!origin) return { min: [bbox.min[0], bbox.min[1], bbox.min[2]], max: [bbox.max[0], bbox.max[1], bbox.max[2]] };
  return {
    min: [bbox.min[0] - origin[0], bbox.min[1] - origin[1], bbox.min[2] - origin[2]],
    max: [bbox.max[0] - origin[0], bbox.max[1] - origin[1], bbox.max[2] - origin[2]],
  };
}

function hasCompleteHeader(bytes: Uint8Array): boolean {
  return /(?:^|\n)[\t ]*end_header[\t ]*\r?\n/.test(HEADER_DECODER.decode(bytes));
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
