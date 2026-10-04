/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LAZ streaming source backed by `laz-perf` (Apache-2.0).
 *
 * Phase 2 v1: load the whole .laz file into memory, decompress through
 * `LASZip`, and emit chunks of decoded points. Memory-bounded callers
 * apply `streamPointCloud`'s downsampling cap before reaching here.
 *
 * The wasm module is loaded lazily on first `open()` so files that
 * never need LAZ don't pay the wasm-instantiation cost.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  bboxInDecodedFrame,
  decodeLasPoints,
  parseLasHeader,
  sampleMaxRgbChannel,
  type LasHeader,
} from '../formats/las.js';
import { loadLazPerf, type LasZipInstance, type LazPerfModule } from './laz-perf-loader.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

export class LazStreamingSource implements StreamingPointSource {
  private blob: Blob;
  private downsample: DownsampleHint;
  private label?: string;

  // Populated by open()
  private mod: LazPerfModule | null = null;
  private laszip: LasZipInstance | null = null;
  private header: LasHeader | null = null;
  private fileBytes: Uint8Array | null = null;
  private filePtr = 0;
  private pointPtr = 0;
  private pointBuffer: Uint8Array | null = null;
  private cursor = 0;
  private rgbScale = 1;
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
    this.blob = blob;
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
    this.originOffset = options.originOffset;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    if (this.header) return this.toInfo(this.header);
    abortIfAborted(signal);

    // All allocations happen against locals first; only commit them to
    // `this.*` after every step succeeds. On failure (abort, parse,
    // wasm load), the catch frees the partial state so a retry doesn't
    // hit the early-return at line 1 with a half-open instance.
    let mod: LazPerfModule | undefined;
    let filePtr = 0;
    let pointPtr = 0;
    let laszip: LasZipInstance | undefined;
    try {
      const buf = await this.blob.arrayBuffer();
      abortIfAborted(signal);
      const bytes = new Uint8Array(buf);
      const header = parseLasHeader(bytes);

      mod = await loadLazPerf();
      abortIfAborted(signal);

      filePtr = mod._malloc(bytes.byteLength);
      mod.HEAPU8.set(bytes, filePtr);

      laszip = new mod.LASZip();
      laszip.open(filePtr, bytes.byteLength);

      const pointSize = laszip.getPointLength();
      pointPtr = mod._malloc(pointSize);
      const pointBuffer = new Uint8Array(pointSize);

      let rgbScale = 1;
      if (header.hasRgb) {
        // Forward-only iterator: probe the first ~4096 points, then
        // reset by recreating the LASZip handle.
        const probe = Math.min(4096, header.pointCount);
        const tempBuf = new Uint8Array(probe * pointSize);
        for (let i = 0; i < probe; i++) {
          laszip.getPoint(pointPtr);
          tempBuf.set(mod.HEAPU8.subarray(pointPtr, pointPtr + pointSize), i * pointSize);
        }
        const max = sampleMaxRgbChannel(tempBuf, header);
        rgbScale = max > 0 && max <= 255 ? 65535 / 255 : 1;
        laszip.delete();
        laszip = new mod.LASZip();
        laszip.open(filePtr, bytes.byteLength);
      }

      // Commit — every allocation succeeded.
      this.fileBytes = bytes;
      this.mod = mod;
      this.filePtr = filePtr;
      this.laszip = laszip;
      this.pointPtr = pointPtr;
      this.pointBuffer = pointBuffer;
      this.rgbScale = rgbScale;
      this.header = header;
      this.cursor = 0;
      return this.toInfo(header);
    } catch (err) {
      // Partial allocations — free what we got before throwing.
      try { laszip?.delete(); } catch { /* cleanup — safe to ignore */ }
      if (mod && pointPtr) {
        try { mod._free(pointPtr); } catch { /* cleanup — safe to ignore */ }
      }
      if (mod && filePtr) {
        try { mod._free(filePtr); } catch { /* cleanup — safe to ignore */ }
      }
      throw err;
    }
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      throw new Error(`LazStreamingSource: maxPoints must be > 0 (got ${maxPoints})`);
    }
    if (!this.header || !this.mod || !this.laszip || !this.pointBuffer) {
      throw new Error('LazStreamingSource: open() must be awaited before next()');
    }
    const stride = Math.max(1, this.downsample.stride | 0);
    if (this.cursor >= this.header.pointCount) return null;

    const pointSize = this.pointBuffer.byteLength;
    const remainingSource = this.header.pointCount - this.cursor;
    const sourceTake = stride === 1
      ? Math.min(maxPoints, remainingSource)
      : Math.min(maxPoints * stride, remainingSource);
    const decodedCount = stride === 1 ? sourceTake : Math.ceil(sourceTake / stride);

    const slab = new Uint8Array(decodedCount * pointSize);
    let writeIdx = 0;
    for (let i = 0; i < sourceTake; i++) {
      this.laszip.getPoint(this.pointPtr);
      // For strided reads, only keep every Nth point.
      if (stride === 1 || i % stride === 0) {
        slab.set(
          this.mod.HEAPU8.subarray(this.pointPtr, this.pointPtr + pointSize),
          writeIdx * pointSize,
        );
        writeIdx++;
      }
    }
    this.cursor += sourceTake;

    return decodeLasPoints(slab, this.header, decodedCount, pointSize, this.rgbScale, this.originOffset);
  }

  close(): void {
    try {
      this.laszip?.delete();
    } catch {
      /* cleanup — safe to ignore */
    }
    if (this.mod && this.pointPtr) {
      try { this.mod._free(this.pointPtr); } catch { /* cleanup — safe to ignore */ }
    }
    if (this.mod && this.filePtr) {
      try { this.mod._free(this.filePtr); } catch { /* cleanup — safe to ignore */ }
    }
    this.laszip = null;
    this.mod = null;
    this.header = null;
    this.fileBytes = null;
    this.pointBuffer = null;
    this.filePtr = 0;
    this.pointPtr = 0;
    this.cursor = 0;
  }

  private toInfo(header: LasHeader): PointSourceInfo {
    const stride = Math.max(1, this.downsample.stride | 0);
    return {
      totalPointCount: stride === 1 ? header.pointCount : Math.ceil(header.pointCount / stride),
      // Points are emitted with `originOffset` already subtracted, so the
      // reported box must be translated to match — see `bboxInDecodedFrame`.
      bbox: bboxInDecodedFrame(header.bbox, this.originOffset),
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
