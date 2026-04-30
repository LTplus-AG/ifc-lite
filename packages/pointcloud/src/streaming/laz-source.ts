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
  decodeLasPoints,
  parseLasHeader,
  sampleMaxRgbChannel,
  type LasHeader,
} from '../formats/las.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

interface LasZipInstance {
  delete(): void;
  open(ptr: number, length: number): void;
  getPoint(dest: number): void;
  getCount(): number;
  getPointLength(): number;
  getPointFormat(): number;
}

interface LazPerfModule {
  LASZip: { new (): LasZipInstance };
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

let modulePromise: Promise<LazPerfModule> | null = null;

async function loadLazPerf(): Promise<LazPerfModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // The dynamic import keeps `laz-perf` out of bundles that don't
      // touch LAZ. The package's `main` (Node) and `browser` (web)
      // fields differ — both export a `createLazPerf` factory.
      const lazPerf = await import('laz-perf');
      const factory = (lazPerf as unknown as {
        createLazPerf?: () => Promise<LazPerfModule>;
        default?: () => Promise<LazPerfModule>;
      }).createLazPerf ?? (lazPerf as unknown as {
        default?: () => Promise<LazPerfModule>;
      }).default;
      if (!factory) {
        throw new Error('laz-perf: could not find createLazPerf factory');
      }
      return factory();
    })();
  }
  return modulePromise;
}

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

  constructor(blob: Blob, options: { label?: string; downsample?: DownsampleHint } = {}) {
    this.blob = blob;
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    if (this.header) return this.toInfo(this.header);
    abortIfAborted(signal);

    const buf = await this.blob.arrayBuffer();
    abortIfAborted(signal);
    const bytes = new Uint8Array(buf);
    const header = parseLasHeader(bytes);
    this.header = header;
    this.fileBytes = bytes;

    const mod = await loadLazPerf();
    abortIfAborted(signal);
    this.mod = mod;

    // Copy file bytes into wasm heap
    const filePtr = mod._malloc(bytes.byteLength);
    mod.HEAPU8.set(bytes, filePtr);
    this.filePtr = filePtr;

    const laszip = new mod.LASZip();
    laszip.open(filePtr, bytes.byteLength);
    this.laszip = laszip;

    const pointSize = laszip.getPointLength();
    const pointPtr = mod._malloc(pointSize);
    this.pointPtr = pointPtr;
    this.pointBuffer = new Uint8Array(pointSize);

    if (header.hasRgb) {
      // We can't sample-without-decoding through laz-perf's LASZip
      // (it's a forward-only iterator), so probe the first ~4096 points
      // to learn the RGB scale, then reset the iterator by closing and
      // re-opening LASZip.
      const probe = Math.min(4096, header.pointCount);
      const tempBuf = new Uint8Array(probe * pointSize);
      for (let i = 0; i < probe; i++) {
        laszip.getPoint(pointPtr);
        tempBuf.set(mod.HEAPU8.subarray(pointPtr, pointPtr + pointSize), i * pointSize);
      }
      const max = sampleMaxRgbChannel(tempBuf, header);
      this.rgbScale = max > 0 && max <= 255 ? 65535 / 255 : 1;

      // Reset iterator: delete + recreate the LASZip handle so getPoint
      // starts at point 0 again.
      laszip.delete();
      const fresh = new mod.LASZip();
      fresh.open(filePtr, bytes.byteLength);
      this.laszip = fresh;
    }
    this.cursor = 0;
    return this.toInfo(header);
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
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

    return decodeLasPoints(slab, this.header, decodedCount, pointSize, this.rgbScale);
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
