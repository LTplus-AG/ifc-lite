/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIfcxImageDecoder, decodeIfcxAppearance, encodeIfcxImage } from './appearance-wire.js';

describe('bounded IFCX image transport (#4325)', () => {
  it('preserves rows, alpha and bytes across base64 chunk boundaries with shared decode ownership', () => {
    const rgba = Uint8Array.from({ length: 129 * 65 * 4 }, (_, i) => i % 251);
    const image = encodeIfcxImage({ width: 129, height: 65, rgba, repeatS: false, repeatT: true });
    const decode = createIfcxImageDecoder();
    const decoded = decode('image', image.value);
    assert.deepEqual(decoded.rgba, rgba);
    assert.equal(decode('image', image.value), decoded);
  });

  it('retains original PNG bytes separately from decoded pixels without recompression', () => {
    // A complete 1x1 PNG; the original carrier is archival and is not decoded by this codec.
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const original = { mimeType: 'image/png' as const, bytes };
    const image = encodeIfcxImage({ width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]), repeatS: false, repeatT: false, original });
    const decoded = createIfcxImageDecoder()('image', image.value);
    assert.deepEqual(decoded.original, original);
    assert.equal(encodeIfcxImage({ ...decoded, repeatS: false, repeatT: false }).value.original?.data, image.value.original?.data);
  });

  it('rejects unsupported dimensions and malformed lengths before decoding or allocating pixels', () => {
    const decode = createIfcxImageDecoder();
    for (const width of [0, -1, 1.2, 16_385, Infinity, NaN]) {
      assert.throws(() => decode('bad', { width, height: 1, rgba: '' }), /dimensions/);
    }
    assert.throws(() => decode('bad', { width: 16_384, height: 16_384, rgba: '' }), /budget/);
    for (const rgba of ['', 'AAAAAAAA', 'AAAAAA==\n', 'AAAAA%==', 'AAAA===!']) {
      assert.throws(() => decode('bad', { width: 1, height: 1, rgba }), /invalid|base64|length/);
    }
    assert.throws(() => decode('missing', undefined), /missing image/);
  });

  it('rejects malformed UV and sampler associations instead of silently producing flat geometry', () => {
    const valid = { image: { ref: 'image' }, repeatS: true, repeatT: false, uvs: [0, 0, 1, 0, 1, 1] };
    assert.deepEqual(decodeIfcxAppearance(valid, 3), valid);
    for (const invalid of [{ ...valid, uvs: [0, 0] }, { ...valid, repeatS: 'true' },
      { ...valid, uvs: [0, 0, 1, Infinity, 1, 1] }, { ...valid, uvs: [0, 0, 1, 1e40, 1, 1] },
      { ...valid, image: { ref: 1 } }]) {
      assert.throws(() => decodeIfcxAppearance(invalid, 3), /UV pair/);
    }
  });
});
