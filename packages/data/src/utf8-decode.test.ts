/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  __resetSabDecodeCache,
  __resetScratchBuffer,
  __retainedScratchAllocations,
  __retainedScratchBytes,
  MAX_RETAINED_SCRATCH_BYTES,
  safeUtf8Decode,
  textDecoderAcceptsSab,
} from './utf8-decode.js';

// Imported, never re-declared. Every boundary case below is anchored to the
// production constant: a hand-copied mirror would keep passing after the real
// value changed, and "oversized" would quietly become an under-cap request
// exercising the retained path the test is named against.

/**
 * Force the SAB-copy path by making `TextDecoder.decode` reject the first
 * SAB-backed view it sees, which poisons the acceptance cache. Returns a
 * cleanup that restores the real decoder and both caches.
 */
function forceScratchCopyPath(): () => void {
  __resetSabDecodeCache();
  __resetScratchBuffer();
  const realDecode = TextDecoder.prototype.decode;
  let rejectedOnce = false;
  TextDecoder.prototype.decode = function (
    this: TextDecoder,
    input?: BufferSource,
    ...rest: unknown[]
  ): string {
    const buf = (input as { buffer?: ArrayBufferLike } | undefined)?.buffer ?? input;
    if (!rejectedOnce && buf instanceof SharedArrayBuffer) {
      rejectedOnce = true;
      throw new TypeError('TextDecoder.decode: cannot decode SharedArrayBuffer');
    }
    return realDecode.apply(this, [input as BufferSource, ...(rest as never[])]);
  } as typeof realDecode;
  return () => {
    TextDecoder.prototype.decode = realDecode;
    __resetSabDecodeCache();
    __resetScratchBuffer();
  };
}

/** A SAB-backed view of `size` bytes filled with a repeating ASCII pattern. */
function sabOfSize(size: number): Uint8Array {
  const view = new Uint8Array(new SharedArrayBuffer(size));
  for (let i = 0; i < size; i++) view[i] = 97 + (i % 26);
  return view;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

describe('safeUtf8Decode', () => {
  it('decodes ArrayBuffer-backed views identically to TextDecoder', () => {
    const text = 'IFC4;FILE_SCHEMA(("IFC4"));END-ISO-10303-21;';
    const view = asciiBytes(text);
    expect(safeUtf8Decode(view)).toBe(text);
    expect(safeUtf8Decode(view, 5, 8)).toBe('FIL');
  });

  it('handles empty inputs and out-of-range slices', () => {
    expect(safeUtf8Decode(new Uint8Array(0))).toBe('');
    expect(safeUtf8Decode(asciiBytes('hello'), 2, 2)).toBe('');
  });

  it('decodes SharedArrayBuffer-backed views without throwing', () => {
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('skip: SharedArrayBuffer unavailable in this runtime');
      return;
    }
    __resetSabDecodeCache();
    const text = '#42=IFCWALL(\'guid-x\',$,\'WallA\',$);';
    const sab = new SharedArrayBuffer(text.length);
    new Uint8Array(sab).set(asciiBytes(text));
    const view = new Uint8Array(sab);
    expect(safeUtf8Decode(view)).toBe(text);
    expect(safeUtf8Decode(view, 4, 12)).toBe('IFCWALL(');
  });

  it('falls through to the scratch-copy path when TextDecoder rejects SAB', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    __resetSabDecodeCache();
    const realDecode = TextDecoder.prototype.decode;
    let rejectedOnce = false;
    TextDecoder.prototype.decode = function (
      this: TextDecoder,
      input?: BufferSource,
      ...rest: unknown[]
    ): string {
      const buf = (input as { buffer?: ArrayBufferLike } | undefined)?.buffer ?? input;
      if (!rejectedOnce && buf instanceof SharedArrayBuffer) {
        rejectedOnce = true;
        // Mimic Firefox/Chrome's actual error wording loosely.
        throw new TypeError('TextDecoder.decode: cannot decode SharedArrayBuffer');
      }
      return realDecode.apply(this, [input as BufferSource, ...(rest as never[])]);
    } as typeof realDecode;

    try {
      const text = 'hello world';
      const sab = new SharedArrayBuffer(text.length);
      new Uint8Array(sab).set(asciiBytes(text));
      const view = new Uint8Array(sab);
      // First call probes (and triggers the simulated rejection), then
      // every subsequent call routes through the scratch-copy path.
      expect(safeUtf8Decode(view)).toBe(text);
      expect(safeUtf8Decode(view, 6, 11)).toBe('world');
      expect(textDecoderAcceptsSab()).toBe(false);
    } finally {
      TextDecoder.prototype.decode = realDecode;
      __resetSabDecodeCache();
    }
  });

  it('caches the SAB-acceptance result across calls', () => {
    __resetSabDecodeCache();
    const first = textDecoderAcceptsSab();
    const second = textDecoderAcceptsSab();
    expect(first).toBe(second);
  });
});

// Regression: #2183. A single whole-file decode used to grow the retained
// scratch to the next power of two above the file size and never release
// it (342 MB source -> 512 MB pinned for the lifetime of the realm).
describe('safeUtf8Decode scratch retention', () => {
  it('does not retain a scratch buffer for a decode above the cap', () => {
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('skip: SharedArrayBuffer unavailable in this runtime');
      return;
    }
    const restore = forceScratchCopyPath();
    try {
      const oversized = MAX_RETAINED_SCRATCH_BYTES + 1;
      const view = sabOfSize(oversized);
      expect(safeUtf8Decode(view).length).toBe(oversized);
      // Without this the assertion below also passes when the copy path was
      // never taken at all, i.e. when the SAB-rejection mock failed to engage.
      expect(textDecoderAcceptsSab()).toBe(false);
      expect(__retainedScratchBytes()).toBe(0);
    } finally {
      restore();
    }
  });

  it('still reuses one retained buffer for decodes at or under the cap', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const restore = forceScratchCopyPath();
    try {
      // Poison the acceptance cache with a small decode first.
      expect(safeUtf8Decode(sabOfSize(8)).length).toBe(8);
      const afterSmall = __retainedScratchBytes();
      expect(afterSmall).toBeGreaterThan(0);
      expect(afterSmall).toBeLessThanOrEqual(MAX_RETAINED_SCRATCH_BYTES);

      // A larger but still-eligible decode grows the same retained buffer,
      // and never past the cap.
      expect(safeUtf8Decode(sabOfSize(MAX_RETAINED_SCRATCH_BYTES)).length)
        .toBe(MAX_RETAINED_SCRATCH_BYTES);
      expect(__retainedScratchBytes()).toBe(MAX_RETAINED_SCRATCH_BYTES);
    } finally {
      restore();
    }
  });

  it('leaves the retained buffer untouched when an oversized decode follows a small one', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const restore = forceScratchCopyPath();
    try {
      expect(safeUtf8Decode(sabOfSize(8)).length).toBe(8);
      expect(textDecoderAcceptsSab()).toBe(false);
      const before = __retainedScratchBytes();
      const allocsBefore = __retainedScratchAllocations();
      expect(safeUtf8Decode(sabOfSize(MAX_RETAINED_SCRATCH_BYTES + 1)).length)
        .toBe(MAX_RETAINED_SCRATCH_BYTES + 1);
      expect(__retainedScratchBytes()).toBe(before);
      expect(__retainedScratchAllocations()).toBe(allocsBefore);
    } finally {
      restore();
    }
  });

  // The retained path exists so the millions of 50-500 byte per-entity decodes
  // share one buffer. Size alone cannot tell reuse from "allocate a
  // correctly-sized buffer every call", so assert the allocation count.
  it('reuses a single buffer across repeated small decodes', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const restore = forceScratchCopyPath();
    try {
      expect(safeUtf8Decode(sabOfSize(512)).length).toBe(512);
      expect(textDecoderAcceptsSab()).toBe(false);
      expect(__retainedScratchAllocations()).toBe(1);
      for (const size of [256, 512, 128, 1024, 64]) {
        expect(safeUtf8Decode(sabOfSize(size)).length).toBe(size);
      }
      // Still one allocation: every size above fits inside the first buffer.
      expect(__retainedScratchAllocations()).toBe(1);
      // Growing past it costs exactly one more allocation, not one per call.
      expect(safeUtf8Decode(sabOfSize(9000)).length).toBe(9000);
      expect(safeUtf8Decode(sabOfSize(9000)).length).toBe(9000);
      expect(__retainedScratchAllocations()).toBe(2);
    } finally {
      restore();
    }
  });
});
