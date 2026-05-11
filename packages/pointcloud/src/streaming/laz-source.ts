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
      // The shipped `laz-perf.js` shim resolves the wasm via emscripten's
      // `locateFile` and tries `fetch("laz-perf.wasm")` relative to the
      // worker's script directory — which under Vite ends up at
      // `/assets/<chunk>.wasm` (404) or `/laz-perf.wasm` (404 → SPA index
      // HTML served as text/plain, which is what triggered the
      // "MIME type 'text/plain'" failure on autzen-classified.laz).
      //
      // Pre-fetch the wasm via Vite's `?url` asset pipeline (hashed,
      // served with `application/wasm`) and hand the bytes to emscripten
      // as `Module.wasmBinary` so its own fetch is skipped entirely.
      const wasmBinary = await fetchLazPerfWasm();

      // Dynamic import keeps `laz-perf` out of bundles that don't touch
      // LAZ. The package is shipped as CommonJS (`lib/{node,web}/index.js`),
      // and Vite/webpack wrap CJS imports under `.default` — but the way
      // they do that varies, so probe every shape we might see:
      //   • { createLazPerf }                     — pure-ESM build
      //   • { default: { createLazPerf } }        — Vite default-wrapper
      //   • { default: createLazPerf }            — esModuleInterop on a fn
      //   • module-as-function (legacy UMD)        — `lazPerf` IS the factory
      const ns = (await import('laz-perf')) as unknown as Record<string, unknown>;
      type Factory = (moduleOverrides?: Record<string, unknown>) => Promise<LazPerfModule>;
      const dflt = ns.default as Record<string, unknown> | (() => unknown) | undefined;
      const candidates: Array<unknown> = [
        ns.createLazPerf,
        typeof dflt === 'object' && dflt !== null ? (dflt as Record<string, unknown>).createLazPerf : undefined,
        dflt,
        // Some bundlers expose the CJS module as the namespace object itself.
        ns,
      ];
      const factory = candidates.find((c) => typeof c === 'function') as Factory | undefined;
      if (!factory) {
        const keys = Object.keys(ns as Record<string, unknown>).join(', ');
        throw new Error(
          `laz-perf: could not find createLazPerf factory (saw keys: ${keys || '<empty>'})`,
        );
      }
      return factory({ wasmBinary });
    })();
  }
  return modulePromise;
}

async function fetchLazPerfWasm(): Promise<Uint8Array> {
  // `?url` triggers Vite's asset pipeline so the .wasm ends up in the
  // build output with the right MIME type. Wrapped in a try/catch so
  // non-Vite hosts (e.g. node-side tests) can fall back to the package's
  // own `locateFile` resolution.
  let wasmUrl: string | undefined;
  try {
    const mod = (await import('laz-perf/lib/web/laz-perf.wasm?url')) as { default: string };
    wasmUrl = mod.default;
  } catch (err) {
    throw new Error(
      `laz-perf: could not resolve wasm asset URL (${err instanceof Error ? err.message : String(err)}). `
      + 'Ensure the bundler treats `laz-perf/lib/web/laz-perf.wasm?url` as a static asset.',
    );
  }
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`laz-perf: wasm fetch failed (${response.status} ${response.statusText}) for ${wasmUrl}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
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
