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
    // Real laz-perf reports the compressed stream's own record count here;
    // `LazStreamingSource.open()` cross-checks it against the plain LAS
    // header's `pointCount` and rejects a mismatch (truncated/corrupt
    // file). This stub doesn't model a specific file's record count, so
    // report a value that never trips that check — the mismatch path has
    // its own dedicated test below with a stub that DOES model it.
    getCount(): number { return Number.MAX_SAFE_INTEGER; }
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

/**
 * Stand-in for the emscripten module whose `getPoint` writes a distinct,
 * incrementing x value (record index) into the point buffer on every
 * call — regardless of whether the source record is kept or skipped by
 * the downsampling selector. This lets a test tell exactly which source
 * indices survived stride selection, not just how many points came out.
 */
function stubLazPerfModuleWithCounter(): LazPerfModule {
  const heap = new Uint8Array(1 << 16);
  let next = 8;
  let callIndex = 0;
  class StubLasZip implements LasZipInstance {
    open(): void { /* no-op — the stub never decompresses */ }
    getPoint(dest: number): void {
      const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
      view.setInt32(dest, callIndex, true);
      callIndex++;
    }
    getCount(): number { return Number.MAX_SAFE_INTEGER; }
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

/**
 * Same layout as `buildLazFile` but with an explicit header bbox — needed
 * to check `toInfo()`'s `bboxInDecodedFrame` translation, which
 * `buildLazFile`'s all-zero header can't exercise (a zero bbox looks
 * "translated" whether or not the subtraction actually ran).
 */
function buildLazFileWithBbox(
  pointCount: number,
  bbox: { min: [number, number, number]; max: [number, number, number] },
): Blob {
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
  view.setFloat64(179, bbox.max[0], true);
  view.setFloat64(187, bbox.min[0], true);
  view.setFloat64(195, bbox.max[1], true);
  view.setFloat64(203, bbox.min[1], true);
  view.setFloat64(211, bbox.max[2], true);
  view.setFloat64(219, bbox.min[2], true);
  return new Blob([buf], { type: 'application/octet-stream' });
}

describe('LazStreamingSource downsampling', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('keeps every Nth source record (0, stride, 2*stride, ...) and sizes the slab accordingly', async () => {
    restore = setLazPerfLoaderForTesting(async () => stubLazPerfModuleWithCounter());

    const src = new LazStreamingSource(buildLazFile(10), { downsample: { stride: 3 } });
    await src.open();
    const chunk = await src.next(100);
    expect(chunk).not.toBeNull();
    // 10 source points, stride 3 -> indices 0,3,6,9 kept -> 4 decoded points.
    expect(chunk!.pointCount).toBe(4);
    const xs = Array.from({ length: chunk!.pointCount }, (_, i) => chunk!.positions[i * 3]);
    expect(xs).toEqual([0, 3, 6, 9]);
  });
});

describe('LazStreamingSource originOffset (issue #1804)', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('reports the bbox in the same frame as the points it emits, same as LasStreamingSource', async () => {
    // `bboxInDecodedFrame` is shared by both streaming sources specifically
    // so a fix to one doesn't silently leave the other behind (see the
    // function's doc comment in formats/las.ts) — but only
    // `las-source.test.ts` pins this. LAZ shares the exact same code path
    // (decodeLasPoints + bboxInDecodedFrame, both fed `this.originOffset`)
    // yet had zero coverage: a future edit that updates one call site and
    // not the other would pass this suite silently.
    restore = setLazPerfLoaderForTesting(async () => stubLazPerfModuleWithCounter());

    // Header bbox is the RAW (pre-subtraction) box; points come out of the
    // stub with x = source record index (0, 1, 2, ...), y = z = 0.
    const blob = buildLazFileWithBbox(3, { min: [0, 0, 0], max: [2, 0, 0] });
    const originOffset = [100, 200, 300] as const;
    const src = new LazStreamingSource(blob, { originOffset });
    const info = await src.open();
    expect(info.bbox).toEqual({ min: [-100, -200, -300], max: [-98, -200, -300] });

    // Cross-check against the actual emitted points: every point must fall
    // inside the reported box — the invariant issue #1804 broke for LAS.
    const chunk = await src.next(16);
    expect(chunk).not.toBeNull();
    const { positions, pointCount } = chunk!;
    for (let i = 0; i < pointCount; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[i * 3 + axis];
        expect(v).toBeGreaterThanOrEqual(info.bbox.min[axis]);
        expect(v).toBeLessThanOrEqual(info.bbox.max[axis]);
      }
    }
  });
});

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

/**
 * `header.pointCount` (the plain-text LAS public header field) and
 * `laszip.getCount()` (the wasm decoder's own record count, parsed from
 * the LAZ special VLR) normally agree — both come from the same encoder
 * run. A truncated download or a corrupt/malicious file can make them
 * disagree. Before this test, `LazStreamingSource` never called
 * `getCount()` at all: `next()` (and the RGB probe in `open()`) loop
 * `header.pointCount` times calling `laszip.getPoint()` — past the
 * decoder's real count that's an out-of-bounds read at the wasm
 * boundary, not a checked error.
 */
function stubLazPerfModuleWithFixedCount(compressedCount: number): { module: LazPerfModule } {
  const heap = new Uint8Array(1 << 16);
  let next = 8;
  class StubLasZip implements LasZipInstance {
    open(): void { /* no-op — the stub never decompresses */ }
    getPoint(): void { /* no-op */ }
    getCount(): number { return compressedCount; }
    getPointLength(): number { return RECORD_LEN; }
    getPointFormat(): number { return 0; }
    delete(): void { /* no-op */ }
  }
  const module: LazPerfModule = {
    LASZip: StubLasZip,
    HEAPU8: heap,
    _malloc: (size: number) => {
      const ptr = next;
      next += size;
      return ptr;
    },
    _free: () => { /* no-op */ },
  };
  return { module };
}

describe('LazStreamingSource — header/compressed-stream point count mismatch', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('rejects open() when the header claims more points than the compressed stream holds', async () => {
    const { module } = stubLazPerfModuleWithFixedCount(2);
    restore = setLazPerfLoaderForTesting(async () => module);

    // Header declares 10 points; the (stub) compressed stream only has 2.
    await expect(new LazStreamingSource(buildLazFile(10)).open())
      .rejects.toThrow(/header declares 10 points but the compressed stream only holds 2/);
  });

  it('frees the wasm allocations it made before rejecting on a count mismatch', async () => {
    const freed: number[] = [];
    const deletedCalls: number[] = [0];
    const heap = new Uint8Array(1 << 16);
    let next = 8;
    class StubLasZip implements LasZipInstance {
      open(): void { /* no-op */ }
      getPoint(): void { /* no-op */ }
      getCount(): number { return 0; }
      getPointLength(): number { return RECORD_LEN; }
      getPointFormat(): number { return 0; }
      delete(): void { deletedCalls[0]++; }
    }
    const module: LazPerfModule = {
      LASZip: StubLasZip,
      HEAPU8: heap,
      _malloc: (size: number) => { const ptr = next; next += size; return ptr; },
      _free: (ptr: number) => { freed.push(ptr); },
    };
    restore = setLazPerfLoaderForTesting(async () => module);

    await expect(new LazStreamingSource(buildLazFile(5)).open()).rejects.toThrow();

    // The `filePtr` malloc from before `laszip.open()` must be freed by
    // the catch block's cleanup — same lifecycle contract as any other
    // failure path in `open()` (abort, parse error, wasm load failure).
    expect(freed.length).toBeGreaterThan(0);
    expect(deletedCalls[0]).toBe(1);
  });

  it('accepts open() when the compressed stream holds AT LEAST as many points as the header declares', async () => {
    const { module } = stubLazPerfModuleWithFixedCount(10);
    restore = setLazPerfLoaderForTesting(async () => module);

    const info = await new LazStreamingSource(buildLazFile(10)).open();
    expect(info.totalPointCount).toBe(10);
  });
});
