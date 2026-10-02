/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';

// #6709: run the actual Renderer.render viewport path. Only the GPU is absent;
// buffer measurement, configured preferences and per-frame options are real.
// An unbound context stops after resizing, before GPU encoding.
describe('Renderer frame-local resolution (#6709)', () => {
  it('restores capture-frame dimensions and respects a lower consumer cap', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } });
    try {
      const canvas = {
        width: 0, height: 0,
        getBoundingClientRect: () => ({ width: 600, height: 400 }),
      } as unknown as HTMLCanvasElement;
      const renderer = new Renderer(canvas);
      const deviceState = renderer['device'] as unknown as Record<string, unknown>;
      deviceState.device = { limits: { maxTextureDimension2D: 8192 } };
      deviceState.context = {}; // Initialized, but deliberately not bound to a GPU canvas.
      const resizes: number[][] = [];
      (renderer as unknown as Record<string, unknown>).pipeline = {
        resize: (width: number, height: number) => resizes.push([width, height]),
      };
      renderer.render({ maxPixelRatio: 1, isInteracting: true });
      assert.deepEqual([canvas.width, canvas.height], [600, 400]);
      renderer.render({ restoreEvictedForCapture: true });
      assert.deepEqual([canvas.width, canvas.height], [1200, 800]);
      renderer.setMaxPixelRatio(1.5);
      renderer.render({ maxPixelRatio: 2 });
      assert.deepEqual([canvas.width, canvas.height], [900, 600]);
      renderer.render({ maxPixelRatio: 0 });
      assert.deepEqual([canvas.width, canvas.height], [900, 600]);
      assert.deepEqual(resizes, [[600, 400], [1200, 800], [900, 600]], 'no repeated target allocation at unchanged dimensions');
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
