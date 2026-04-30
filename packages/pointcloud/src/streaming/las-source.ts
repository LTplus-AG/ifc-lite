/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LAS streaming source.
 *
 * Implements `StreamingPointSource` over a `BlobByteSource`. Reads the
 * 227-byte public header on `open()`, then yields chunks of decoded
 * points on each `next()`. Stride-based downsampling is supported
 * natively: when `stride > 1`, the source advances by `stride * recordLen`
 * bytes per emitted point.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  decodeLasPoints,
  parseLasHeader,
  sampleMaxRgbChannel,
  type LasHeader,
} from '../formats/las.js';
import { BlobByteSource } from './blob-source.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

const HEADER_PROBE_BYTES = 1024;
/** RGB-detection probe: read up to 256 KB worth of point records. */
const RGB_PROBE_RECORDS = 4096;

export class LasStreamingSource implements StreamingPointSource {
  private bytes: BlobByteSource;
  private header: LasHeader | null = null;
  private cursor = 0; // index of NEXT point to emit (0..header.pointCount)
  private rgbScale = 1;
  private downsample: DownsampleHint;
  private label?: string;

  constructor(blob: Blob, options: { label?: string; downsample?: DownsampleHint } = {}) {
    this.bytes = new BlobByteSource(blob);
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    if (this.header) {
      return this.toInfo(this.header);
    }
    abortIfAborted(signal);
    const headerBytes = await this.bytes.read(0, HEADER_PROBE_BYTES);
    abortIfAborted(signal);
    const header = parseLasHeader(headerBytes);
    this.header = header;

    if (header.hasRgb) {
      // Read a small slab of point records to decide on the RGB scale.
      // Producers that store 8-bit values in u16 channels will all max out
      // around 255; producers that use the full 16-bit range hit > 1024.
      const probeSize = Math.min(
        RGB_PROBE_RECORDS * header.pointRecordLength,
        Math.max(0, this.bytes.size - header.pointDataOffset),
      );
      if (probeSize > 0) {
        const probe = await this.bytes.read(
          header.pointDataOffset,
          header.pointDataOffset + probeSize,
        );
        const max = sampleMaxRgbChannel(probe, header);
        // Threshold matches PDAL / cloudcompare behaviour: ≤ 255 → assume
        // 8-bit-in-u16 and rescale on decode so values reach 0..1 in float.
        this.rgbScale = max > 0 && max <= 255 ? 65535 / 255 : 1;
      }
    }
    this.cursor = 0;
    return this.toInfo(header);
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!this.header) {
      throw new Error('LasStreamingSource: open() must be awaited before next()');
    }
    const stride = Math.max(1, this.downsample.stride | 0);
    if (this.cursor >= this.header.pointCount) return null;

    if (stride === 1) {
      const remaining = this.header.pointCount - this.cursor;
      const take = Math.min(maxPoints, remaining);
      const startByte = this.header.pointDataOffset + this.cursor * this.header.pointRecordLength;
      const endByte = startByte + take * this.header.pointRecordLength;
      const slab = await this.bytes.read(startByte, endByte);
      abortIfAborted(signal);
      const chunk = decodeLasPoints(slab, this.header, take, this.header.pointRecordLength, this.rgbScale);
      this.cursor += take;
      return chunk;
    }

    // Strided reads: pull a packed slab covering `take * stride` source
    // records, then decode every Nth record.
    const remainingSource = this.header.pointCount - this.cursor;
    const sourceTake = Math.min(maxPoints * stride, remainingSource);
    const decodedCount = Math.ceil(sourceTake / stride);
    const startByte = this.header.pointDataOffset + this.cursor * this.header.pointRecordLength;
    const endByte = startByte + sourceTake * this.header.pointRecordLength;
    const slab = await this.bytes.read(startByte, endByte);
    abortIfAborted(signal);

    // Build a compacted slab that contains only the records we want, then
    // hand it to decodeLasPoints with stride === recordLen.
    const compact = new Uint8Array(decodedCount * this.header.pointRecordLength);
    let writeOff = 0;
    for (let i = 0; i < decodedCount; i++) {
      const srcOff = i * stride * this.header.pointRecordLength;
      compact.set(
        slab.subarray(srcOff, srcOff + this.header.pointRecordLength),
        writeOff,
      );
      writeOff += this.header.pointRecordLength;
    }
    const chunk = decodeLasPoints(compact, this.header, decodedCount, this.header.pointRecordLength, this.rgbScale);
    this.cursor += sourceTake;
    return chunk;
  }

  close(): void {
    this.header = null;
    this.cursor = 0;
  }

  private toInfo(header: LasHeader): PointSourceInfo {
    const stride = Math.max(1, this.downsample.stride | 0);
    return {
      totalPointCount: stride === 1 ? header.pointCount : Math.ceil(header.pointCount / stride),
      bbox: header.bbox,
      hasColor: header.hasRgb,
      hasClassification: true,
      hasIntensity: true,
      label: this.label,
    };
  }
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
