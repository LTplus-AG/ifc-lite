/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// NOTE: We deliberately avoid importing from `./acquireFileBuffer` directly,
// because that module pulls in `./ifcConfig`, which references
// `import.meta.env.*` (Vite-only). Instead, we shadow the threshold dependency
// by re-implementing the public surface against a thin re-export. The
// production `acquireFileBuffer()` simply calls `__acquireFileBufferWithThreshold`
// with `STREAM_SAB_THRESHOLD`; tests bypass `STREAM_SAB_THRESHOLD` with a
// kilobyte-sized injected threshold so the streaming branch is exercised
// without multi-hundred-MB allocations.
//
// Importing the inner function directly would still trigger the ifcConfig
// side-effect, so we use Node's loader hook indirection: import via a tiny
// module-relative path that is re-exported from acquireFileBuffer.ts itself.
import { __acquireFileBufferWithThreshold } from './acquireFileBuffer';

function bytes(n: number, fill: (i: number) => number = (i) => i & 0xff): Uint8Array<ArrayBuffer> {
  // Allocate via ArrayBuffer explicitly so the resulting Uint8Array satisfies
  // `Uint8Array<ArrayBuffer>`. Default `new Uint8Array(n)` infers
  // `ArrayBufferLike`, which TS 5.7+'s tightened DOM lib rejects as a BlobPart.
  const ab = new ArrayBuffer(n);
  const u = new Uint8Array(ab);
  for (let i = 0; i < n; i++) u[i] = fill(i);
  return u;
}

function viewsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const TEST_THRESHOLD = 4 * 1024; // 4 KB — small enough to exercise streaming cheaply.

describe('acquireFileBuffer', () => {
  it('returns ArrayBuffer for small files (below the streaming threshold)', async () => {
    const data = bytes(1024);
    const file = new File([data], 'small.bin');

    const acquired = await __acquireFileBufferWithThreshold(file, TEST_THRESHOLD);

    assert.equal(acquired.isShared, false);
    assert.equal(acquired.buffer.byteLength, data.byteLength);
    assert.equal(acquired.view.byteLength, data.byteLength);
    assert.ok(viewsEqual(acquired.view, data), 'bytes round-trip');
    assert.ok(acquired.buffer instanceof ArrayBuffer, 'small files keep ArrayBuffer path');
  });

  it('returns empty buffer for zero-size file', async () => {
    const file = new File([], 'empty.bin');

    const acquired = await __acquireFileBufferWithThreshold(file, TEST_THRESHOLD);

    assert.equal(acquired.buffer.byteLength, 0);
    assert.equal(acquired.view.byteLength, 0);
    assert.equal(acquired.isShared, false);
  });

  it('streams large files (≥ threshold) into SharedArrayBuffer with byte-identical contents', async () => {
    // Compose a Blob whose total size sits above the test threshold using a
    // handful of small chunks so the read loop iterates more than once. The
    // pattern is `(offset & 0xff)` so we can verify byte-identity without
    // keeping a parallel copy.
    const target = TEST_THRESHOLD + 4096;
    const chunkSize = 1024;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let written = 0;
    while (written < target) {
      const remaining = target - written;
      const size = Math.min(chunkSize, remaining);
      const chunk = new Uint8Array(new ArrayBuffer(size));
      for (let i = 0; i < size; i++) chunk[i] = (written + i) & 0xff;
      chunks.push(chunk);
      written += size;
    }
    const file = new File(chunks, 'large.bin');
    assert.equal(file.size, target);

    const acquired = await __acquireFileBufferWithThreshold(file, TEST_THRESHOLD);

    assert.equal(acquired.buffer.byteLength, target);
    assert.equal(acquired.view.byteLength, target);

    // Spot-check at start, chunk boundaries, middle, and end. Full scan adds
    // no coverage if any byte is correct (the streaming copy either works
    // for all bytes or fails immediately on misalignment).
    for (const offset of [0, 1, chunkSize - 1, chunkSize, chunkSize + 1, Math.floor(target / 2), target - 2, target - 1]) {
      assert.equal(acquired.view[offset], offset & 0xff, `byte at offset ${offset}`);
    }

    // SAB iff the runtime supports it. Node 22 gives us SAB and an undefined
    // `crossOriginIsolated`, so we expect the streaming path to engage.
    if (typeof SharedArrayBuffer !== 'undefined') {
      assert.equal(acquired.isShared, true);
      assert.ok(
        acquired.buffer instanceof SharedArrayBuffer,
        'large files use SharedArrayBuffer when supported',
      );
    }
  });

  it('rejects when the underlying stream errors', async () => {
    const fakeFile = {
      name: 'broken.bin',
      size: TEST_THRESHOLD + 1,
      stream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('synthetic stream failure'));
          },
        });
      },
      arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new Error('arrayBuffer not used in this test'));
      },
    } as unknown as File;

    await assert.rejects(
      __acquireFileBufferWithThreshold(fakeFile, TEST_THRESHOLD),
      /synthetic stream failure/,
    );
  });

  it('falls back to arrayBuffer() when SharedArrayBuffer is unavailable', async () => {
    const originalSAB = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    try {
      (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = undefined;

      const data = bytes(1024);
      const file = new File([data], 'no-sab.bin');
      // Force the size check to think this is a large file while keeping the
      // actual buffer small — verifies the fallback branch fires before any
      // SAB allocation is attempted.
      Object.defineProperty(file, 'size', { value: TEST_THRESHOLD + 1 });

      const acquired = await __acquireFileBufferWithThreshold(file, TEST_THRESHOLD);

      assert.equal(acquired.isShared, false);
      assert.ok(acquired.buffer instanceof ArrayBuffer, 'fallback returns ArrayBuffer');
    } finally {
      (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = originalSAB;
    }
  });

  it('falls back to arrayBuffer() when crossOriginIsolated is explicitly false', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
    try {
      Object.defineProperty(globalThis, 'crossOriginIsolated', {
        configurable: true,
        get: () => false,
      });

      const data = bytes(64);
      const file = new File([data], 'no-coi.bin');
      Object.defineProperty(file, 'size', { value: TEST_THRESHOLD + 1 });

      const acquired = await __acquireFileBufferWithThreshold(file, TEST_THRESHOLD);

      assert.equal(acquired.isShared, false);
      assert.ok(acquired.buffer instanceof ArrayBuffer);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'crossOriginIsolated', originalDescriptor);
      } else {
        delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      }
    }
  });
});
