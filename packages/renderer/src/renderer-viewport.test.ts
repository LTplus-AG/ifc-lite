/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5383: the drawing buffer follows the element's device-pixel size and keeps
 * its aspect. The numbers are the issue's measurement (a 926.6 x 817.5 CSS px
 * viewport, which used to get a 896 x 817 buffer at every pixel ratio).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeDrawingBufferSize, MAX_DRAWING_BUFFER_PIXEL_RATIO } from './renderer-viewport.js';

const CSS_W = 926.6;
const CSS_H = 817.5;

describe('computeDrawingBufferSize (#5383)', () => {
  it('matches the element at DPR 1 instead of flooring the width to a multiple of 64', () => {
    const size = computeDrawingBufferSize(CSS_W, CSS_H, 1, 8192);
    assert.deepStrictEqual({ width: size?.width, height: size?.height }, { width: 927, height: 818 });
  });

  it('renders HiDPI screens at their device-pixel size', () => {
    const size = computeDrawingBufferSize(CSS_W, CSS_H, 2, 8192);
    assert.deepStrictEqual({ width: size?.width, height: size?.height }, { width: 1853, height: 1635 });
    assert.ok(Math.abs((size?.pixelRatio ?? 0) - 2) < 1e-3);
  });

  it('keeps the element aspect, so circles stay round', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const size = computeDrawingBufferSize(CSS_W, CSS_H, dpr, 8192);
      assert.ok(size);
      const skew = Math.abs(size.width / size.height - CSS_W / CSS_H) / (CSS_W / CSS_H);
      // Integer rounding only: under one pixel of the shorter axis.
      assert.ok(skew < 1 / CSS_H, `dpr ${dpr}: aspect skew ${skew}`);
    }
  });

  it('caps the ratio so a 3x display does not allocate 9x the fill', () => {
    const size = computeDrawingBufferSize(400, 300, 3, 8192);
    assert.deepStrictEqual(
      { width: size?.width, height: size?.height, pixelRatio: size?.pixelRatio },
      { width: 400 * MAX_DRAWING_BUFFER_PIXEL_RATIO, height: 300 * MAX_DRAWING_BUFFER_PIXEL_RATIO, pixelRatio: MAX_DRAWING_BUFFER_PIXEL_RATIO },
    );
  });

  it('follows a lower max pixel ratio, so a HiDPI screen can render at CSS pixels', () => {
    const size = computeDrawingBufferSize(CSS_W, CSS_H, 2, 8192, 1);
    assert.deepStrictEqual(
      { width: size?.width, height: size?.height, pixelRatio: size?.pixelRatio },
      { width: 927, height: 818, pixelRatio: 927 / CSS_W },
    );
    assert.strictEqual(computeDrawingBufferSize(400, 300, 3, 8192, 1.5)?.width, 600);
    // A cap above the display's ratio does not upscale past it.
    assert.strictEqual(computeDrawingBufferSize(400, 300, 1, 8192, 2)?.width, 400);
  });

  it('falls back to the default cap for a non-finite or non-positive max pixel ratio', () => {
    for (const cap of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.strictEqual(computeDrawingBufferSize(400, 300, 3, 8192, cap)?.width, 400 * MAX_DRAWING_BUFFER_PIXEL_RATIO, `cap ${cap}`);
    }
  });

  it('lowers the ratio on BOTH axes when one would exceed the max texture dimension', () => {
    // A tall iframe at DPR 2: 9000 device px of height does not fit 8192.
    const size = computeDrawingBufferSize(1000, 4500, 2, 8192);
    assert.ok(size);
    assert.strictEqual(size.height, 8192);
    assert.ok(size.width <= 8192);
    assert.ok(Math.abs(size.width / size.height - 1000 / 4500) < 1 / 4500, 'aspect kept, not squashed');
  });

  it('returns null for a collapsed or non-finite layout, and treats a bad DPR as 1', () => {
    assert.strictEqual(computeDrawingBufferSize(0, 500, 2, 8192), null);
    assert.strictEqual(computeDrawingBufferSize(500, 0, 2, 8192), null);
    assert.strictEqual(computeDrawingBufferSize(Number.NaN, 500, 2, 8192), null);
    assert.strictEqual(computeDrawingBufferSize(500, 400, Number.NaN, 8192)?.width, 500);
    assert.strictEqual(computeDrawingBufferSize(500, 400, 0, 8192)?.width, 500);
  });
});

// #6709: navigation resolution must not become a persistent capture preference.
describe('frame-local drawing-buffer resolution', () => {
  it('restores configured quality for the next capture-style frame', () => {
    assert.deepEqual(computeDrawingBufferSize(600, 400, 2, 8192, 2, 1), { width: 600, height: 400, pixelRatio: 1 });
    assert.deepEqual(computeDrawingBufferSize(600, 400, 2, 8192, 2), { width: 1200, height: 800, pixelRatio: 2 });
    assert.deepEqual(computeDrawingBufferSize(600, 400, 2, 8192, 1.5, 2), { width: 900, height: 600, pixelRatio: 1.5 });
  });
  it('preserves DPR1 and ignores invalid frame caps without bypassing the configured cap', () => {
    for (const dpr of [1, 2]) {
      for (const cap of [undefined, 0, -1, Infinity, NaN]) {
        assert.deepEqual(computeDrawingBufferSize(600, 400, dpr, 8192, 1.5, cap), computeDrawingBufferSize(600, 400, dpr, 8192, 1.5));
      }
    }
    assert.deepEqual(computeDrawingBufferSize(600, 400, 1, 8192, 2, 1), computeDrawingBufferSize(600, 400, 1, 8192, 2));
  });
});
