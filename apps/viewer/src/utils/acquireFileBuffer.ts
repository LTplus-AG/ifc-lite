/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads a `File` into a single buffer, streaming directly into a
 * `SharedArrayBuffer` for files above `STREAM_SAB_THRESHOLD`. Avoids the
 * doubled peak memory of `await file.arrayBuffer()` followed by a SAB
 * allocation+copy inside the geometry pipeline (issue #600).
 *
 * The returned `view` is suitable for every downstream consumer: parser,
 * fingerprinter, format detector, geometry processor. Each downstream uses
 * `new Uint8Array(buffer)` or works on the view directly, both of which
 * accept SAB-backed views.
 *
 * Cache writes (`saveToCache`) and server uploads do their own copy via
 * structured clone or `Blob`, so SAB ownership doesn't leak into IndexedDB
 * or `fetch`.
 */

import { STREAM_SAB_THRESHOLD } from './ifcConfig.js';

export interface AcquiredBuffer {
  /**
   * Underlying buffer. Either a `SharedArrayBuffer` (large files when SAB is
   * supported) or an `ArrayBuffer` (small files, or environments without
   * cross-origin isolation).
   */
  buffer: ArrayBuffer | SharedArrayBuffer;
  /** Zero-copy view over `buffer`. Pass this to consumers expecting bytes. */
  view: Uint8Array;
  /** Whether the underlying buffer is a SharedArrayBuffer. */
  isShared: boolean;
}

function sharedArrayBufferAvailable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  // `crossOriginIsolated` is the canonical gate; some early implementations
  // lack the global, hence the `?? true` permissiveness — if SAB *exists* in
  // scope the environment is generally COI-enabled.
  const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return coi !== false;
}

/**
 * Reads `file` into an in-memory buffer. Streams chunks into a pre-sized
 * `SharedArrayBuffer` for files ≥ `STREAM_SAB_THRESHOLD` when SAB is
 * available, otherwise falls back to `await file.arrayBuffer()`.
 */
export async function acquireFileBuffer(file: File): Promise<AcquiredBuffer> {
  const useSharedStream =
    file.size >= STREAM_SAB_THRESHOLD
    && sharedArrayBufferAvailable()
    && typeof file.stream === 'function';

  if (!useSharedStream) {
    const buffer = await file.arrayBuffer();
    return {
      buffer,
      view: new Uint8Array(buffer),
      isShared: false,
    };
  }

  const sab = new SharedArrayBuffer(file.size);
  const view = new Uint8Array(sab);
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
  let offset = 0;

  try {
    // Stream chunks from the File directly into the SAB. No intermediate
    // ArrayBuffer means peak memory is ~`fileSize` instead of `2 × fileSize`
    // at this entry point.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > sab.byteLength) {
        // Defensive: file grew while reading (rare, but possible on local
        // disks with active writes). Truncate to the SAB size we promised.
        view.set(value.subarray(0, sab.byteLength - offset), offset);
        offset = sab.byteLength;
        break;
      }
      view.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  // Validate we read the expected number of bytes. A short read indicates
  // the file shrank mid-load; surface it loudly so callers don't silently
  // process a truncated buffer.
  if (offset !== sab.byteLength) {
    throw new Error(
      `acquireFileBuffer: short read for ${file.name} (got ${offset} of ${sab.byteLength} bytes)`,
    );
  }

  return {
    buffer: sab,
    view,
    isShared: true,
  };
}
