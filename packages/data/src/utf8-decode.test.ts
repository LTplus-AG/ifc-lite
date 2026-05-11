/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  __resetSabDecodeCache,
  safeUtf8Decode,
  textDecoderAcceptsSab,
} from './utf8-decode.js';

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
