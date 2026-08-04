/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  LazStreamingSource,
  setLazPerfLoaderForTesting,
  type LasZipInstance,
  type LazPerfModule,
} from './laz-source.js';

const RECORD_LEN = 20; // LAS point format 0

/**
 * A minimal LAS 1.2 header. `open()` parses the header before it touches
 * laz-perf, so the payload never has to be real LAZ — the stub module
 * below stands in for the decompressor.
 */
function buildLazFile(pointCount: number): Blob {
  const headerSize = 227;
  const buf = new ArrayBuffer(headerSize + pointCount * RECORD_LEN);
  const view = new DataView(buf);
  view.setUint32(0, 0x4653414c, true); // "LASF"
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 0);
  view.setUint16(105, RECORD_LEN, true);
  view.setUint32(107, pointCount, true);
  view.setFloat64(131, 1, true);
  view.setFloat64(139, 1, true);
  view.setFloat64(147, 1, true);
  return new Blob([buf], { type: 'application/octet-stream' });
}

/** Stand-in for the emscripten module, with a bump allocator over a fake heap. */
function stubLazPerfModule(): LazPerfModule {
  const heap = new Uint8Array(1 << 16);
  let next = 8;
  class StubLasZip implements LasZipInstance {
    open(): void { /* no-op — the stub never decompresses */ }
    getPoint(): void { /* no-op */ }
    getCount(): number { return 0; }
    getPointLength(): number { return RECORD_LEN; }
    getPointFormat(): number { return 0; }
    delete(): void { /* no-op */ }
  }
  return {
    LASZip: StubLasZip,
    HEAPU8: heap,
    _malloc: (size: number) => {
      const ptr = next;
      next += size;
      return ptr;
    },
    _free: () => { /* no-op */ },
  };
}

describe('LazStreamingSource wasm loading', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('retries the wasm load after a transient failure instead of poisoning every future open', async () => {
    let calls = 0;
    restore = setLazPerfLoaderForTesting(async () => {
      calls++;
      if (calls === 1) throw new Error('wasm fetch failed (503)');
      return stubLazPerfModule();
    });

    // First drop of the file: the wasm fetch fails.
    await expect(new LazStreamingSource(buildLazFile(4)).open())
      .rejects.toThrow('wasm fetch failed (503)');

    // The user re-drops the file. This must retry, not replay the cached
    // rejection — which is exactly what the un-reset memo used to do.
    const info = await new LazStreamingSource(buildLazFile(4)).open();
    expect(info.totalPointCount).toBe(4);
    expect(calls).toBe(2);
  });

  it('shares one wasm load between concurrent opens', async () => {
    let calls = 0;
    restore = setLazPerfLoaderForTesting(async () => {
      calls++;
      return stubLazPerfModule();
    });

    await Promise.all([
      new LazStreamingSource(buildLazFile(1)).open(),
      new LazStreamingSource(buildLazFile(2)).open(),
      new LazStreamingSource(buildLazFile(3)).open(),
    ]);
    expect(calls).toBe(1);
  });

  it('keeps memoising a successful load', async () => {
    let calls = 0;
    restore = setLazPerfLoaderForTesting(async () => {
      calls++;
      return stubLazPerfModule();
    });

    await new LazStreamingSource(buildLazFile(1)).open();
    await new LazStreamingSource(buildLazFile(1)).open();
    expect(calls).toBe(1);
  });
});
