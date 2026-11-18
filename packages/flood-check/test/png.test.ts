/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { HazardResponseError } from '../src/errors.js';
import { decodePng } from '../src/png.js';
import { encodePng, fixture, rgbaPng } from './helpers.js';

function pixel(img: { width: number; rgba: Uint8Array }, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return [...img.rgba.subarray(o, o + 4)];
}

describe('decodePng', () => {
  it('decodes a recorded WMS response (RGBA, all filters) to the colours an independent decoder found', () => {
    const img = decodePng(fixture('bern-three-classes-200px.png'));
    expect([img.width, img.height]).toEqual([200, 200]);
    // First opaque non-legend pixel of this file per an independent (Python/zlib) decode.
    expect(pixel(img, 167, 0)).toEqual([247, 171, 255, 255]);
    const uniform = decodePng(fixture('bern-uniform-9px.png'));
    expect(new Set(Array.from({ length: 81 }, (_, i) => pixel(uniform, i % 9, Math.floor(i / 9)).join()))).toEqual(
      new Set(['255,189,255,255']),
    );
  });

  it('round-trips every row filter', () => {
    const colour = (x: number, y: number) => [(x * 37) & 255, (y * 91) & 255, (x * y) & 255, (x + y) & 255];
    const img = decodePng(rgbaPng(7, 10, colour));
    for (let y = 0; y < 10; y++) for (let x = 0; x < 7; x++) expect(pixel(img, x, y)).toEqual(colour(x, y));
  });

  it('decodes indexed colour at 4 bits with tRNS', () => {
    const palette = [[0, 0, 0], [255, 189, 255], [132, 0, 168]];
    const rows = [new Uint8Array([0x12, 0x00]), new Uint8Array([0x21, 0x10])]; // 3 px wide, 4-bit
    const img = decodePng(encodePng(3, 2, rows, { colourType: 3, bitDepth: 4, palette, trns: [0] }));
    expect(pixel(img, 0, 0)).toEqual([255, 189, 255, 255]);
    expect(pixel(img, 1, 0)).toEqual([132, 0, 168, 255]);
    expect(pixel(img, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(img, 0, 1)).toEqual([132, 0, 168, 255]);
    expect(pixel(img, 1, 1)).toEqual([255, 189, 255, 255]);
  });

  it('applies a truecolour tRNS colour key', () => {
    const rows = [new Uint8Array([1, 2, 3, 9, 9, 9])];
    const img = decodePng(encodePng(2, 1, rows, { colourType: 2, trns: [0, 1, 0, 2, 0, 3] }));
    expect(pixel(img, 0, 0)).toEqual([1, 2, 3, 0]);
    expect(pixel(img, 1, 0)).toEqual([9, 9, 9, 255]);
  });

  it('refuses what it cannot decode exactly', () => {
    expect(() => decodePng(new TextEncoder().encode('<ServiceException/>'))).toThrow(HazardResponseError);
    const rows = [new Uint8Array(8)];
    expect(() => decodePng(encodePng(1, 1, rows, { colourType: 6, interlace: true }))).toThrow(/interlaced/);
    expect(() => decodePng(encodePng(1, 1, [new Uint8Array(8)], { colourType: 6, bitDepth: 16 }))).toThrow(/bit depth 16/);
    const ok = rgbaPng(2, 2, () => [1, 2, 3, 4]);
    expect(() => decodePng(ok.subarray(0, ok.length - 20))).toThrow(HazardResponseError);
  });
});
