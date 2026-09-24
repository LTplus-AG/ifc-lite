/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Camera } from './camera.js';

/**
 * Highest device-pixel ratio the drawing buffer follows. A 3x phone or a
 * browser zoomed past 200% would otherwise allocate 9x+ the CSS-pixel fill
 * (colour, MSAA, depth, object-id targets all scale with it) for a sharpness
 * gain the eye cannot resolve at that density.
 */
export const MAX_DRAWING_BUFFER_PIXEL_RATIO = 2;

export interface DrawingBufferSize {
  /** Drawing-buffer width in device pixels (`canvas.width`). */
  width: number;
  /** Drawing-buffer height in device pixels (`canvas.height`). */
  height: number;
  /**
   * Device pixels per CSS pixel actually applied. Below the display's
   * `devicePixelRatio` when capped by {@link MAX_DRAWING_BUFFER_PIXEL_RATIO}
   * or by the GPU's max texture dimension. Anything authored in CSS pixels
   * (point and glyph sizes, snap and cull thresholds, post-pass tap radii)
   * converts through this, so it looks the same at every density.
   */
  pixelRatio: number;
}

/**
 * The drawing-buffer size for a canvas laid out at `cssWidth` x `cssHeight`
 * CSS pixels on a display with `devicePixelRatio` (#5383).
 *
 * The buffer follows the element's device-pixel size, so a HiDPI screen gets
 * a native-resolution image instead of a CSS-resolution one the browser
 * upscales. Both axes use the SAME ratio and neither is rounded to a multiple
 * of anything, so the buffer's aspect is the element's aspect. The width used
 * to be floored to a multiple of 64 for the 256-byte `bytesPerRow` rule, but
 * that rule binds only `copyTextureToBuffer`, and every readback here (picker,
 * colour-frame capture) pads its own row pitch.
 *
 * When one axis would exceed `maxTextureDimension` the ratio drops for BOTH
 * axes, which keeps the aspect instead of squashing one axis.
 *
 * Returns null for a collapsed or non-finite layout: the caller keeps the
 * buffer it has.
 */
export function computeDrawingBufferSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxTextureDimension: number,
): DrawingBufferSize | null {
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return null;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const maxDim = Number.isFinite(maxTextureDimension) && maxTextureDimension >= 1 ? maxTextureDimension : 8192;
  const ratio = Math.min(dpr, MAX_DRAWING_BUFFER_PIXEL_RATIO, maxDim / cssWidth, maxDim / cssHeight);
  const width = Math.min(maxDim, Math.max(1, Math.round(cssWidth * ratio)));
  const height = Math.min(maxDim, Math.max(1, Math.round(cssHeight * ratio)));
  return { width, height, pixelRatio: width / cssWidth };
}

/**
 * {@link computeDrawingBufferSize} for `canvas`'s current layout on the
 * current display. Null while the element has no layout.
 */
export function measureDrawingBuffer(
  canvas: HTMLCanvasElement,
  maxTextureDimension: number,
): DrawingBufferSize | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return computeDrawingBufferSize(rect.width, rect.height, dpr, maxTextureDimension);
}

export function resizeRendererViewport(
  canvas: HTMLCanvasElement,
  camera: Camera,
  width: number,
  height: number,
): void {
  // `canvas.width` is an IDL `unsigned long`, so it silently coerces a
  // non-finite or negative argument to **0** — a zero drawing buffer
  // that every pick guard in this package misses, because they all
  // check the bounding rect rather than the buffer. `unprojectToRay`
  // then divides by it. This is documented public API of a published
  // package (`docs/api/typescript.md`), so an external caller wiring a
  // ResizeObserver to it is the reachable route; both in-repo callers
  // already floor their own values. Keep the last usable size, the same
  // policy `setAspect` uses for the ratio it derives (#2473).
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return;
  canvas.width = width;
  canvas.height = height;
  camera.setAspect(width / height);
}
