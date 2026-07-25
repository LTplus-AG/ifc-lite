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
  private originOffset?: readonly [number, number, number];

  constructor(
    blob: Blob,
    options: {
      label?: string;
      downsample?: DownsampleHint;
      /** See `decodeLasPoints`'s `originOffset` param (issue #1804). */
      originOffset?: readonly [number, number, number];
    } = {},
  ) {
    this.bytes = new BlobByteSource(blob);
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
    this.originOffset = options.originOffset;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    if (this.header) {
      return this.toInfo(this.header);
    }
    abortIfAborted(signal);
    const headerBytes = await this.bytes.read(0, HEADER_PROBE_BYTES);
    abortIfAborted(signal);
    // Use locals through the whole probe so a partial failure (abort
    // mid-RGB-probe, parse error) doesn't leave `this.header` set —
    // otherwise a retry returns the cached info without re-running the
    // RGB-scale detection and silently uses the wrong scale.
    const header = parseLasHeader(headerBytes);
    let rgbScale = 1;

    if (header.hasRgb) {
      const probeSize = Math.min(
        RGB_PROBE_RECORDS * header.pointRecordLength,
        Math.max(0, this.bytes.size - header.pointDataOffset),
      );
      if (probeSize > 0) {
        const probe = await this.bytes.read(
          header.pointDataOffset,
          header.pointDataOffset + probeSize,
        );
        abortIfAborted(signal);
        const max = sampleMaxRgbChannel(probe, header);
        // Threshold matches PDAL / cloudcompare behaviour: ≤ 255 → assume
        // 8-bit-in-u16 and rescale on decode so values reach 0..1 in float.
        rgbScale = max > 0 && max <= 255 ? 65535 / 255 : 1;
      }
    }

    this.header = header;
    this.rgbScale = rgbScale;
    this.cursor = 0;
    return this.toInfo(header);
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      // 0/negative would emit empty chunks without advancing the cursor,
      // creating a non-terminating loop in the host.
      throw new Error(`LasStreamingSource: maxPoints must be > 0 (got ${maxPoints})`);
    }
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
      const chunk = decodeLasPoints(
        slab, this.header, take, this.header.pointRecordLength, this.rgbScale, this.originOffset,
      );
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
    const chunk = decodeLasPoints(
      compact, this.header, decodedCount, this.header.pointRecordLength, this.rgbScale, this.originOffset,
    );
    this.cursor += sourceTake;
    return chunk;
  }

  close(): void {
    this.header = null;
    this.cursor = 0;
  }

  private toInfo(header: LasHeader): PointSourceInfo {
    const stride = Math.max(1, this.downsample.stride | 0);
    // `header.bbox` is in absolute native CRS coordinates, but every point we
    // emit has `originOffset` subtracted in f64 first (see `decodeLasPoints`).
    // Reporting the raw header box would leave the bounds and the points they
    // describe in DIFFERENT frames — off by the full offset, which at map
    // magnitudes (LV95 easting ~2.6e6) puts framing, culling and the
    // height-ramp colour range nowhere near the actual geometry. Translate by
    // the same offset, component-wise on the same x/y/z axes.
    const bbox = this.originOffset
      ? {
        min: [
          header.bbox.min[0] - this.originOffset[0],
          header.bbox.min[1] - this.originOffset[1],
          header.bbox.min[2] - this.originOffset[2],
        ] as [number, number, number],
        max: [
          header.bbox.max[0] - this.originOffset[0],
          header.bbox.max[1] - this.originOffset[1],
          header.bbox.max[2] - this.originOffset[2],
        ] as [number, number, number],
      }
      : header.bbox;
    return {
      totalPointCount: stride === 1 ? header.pointCount : Math.ceil(header.pointCount / stride),
      bbox,
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
