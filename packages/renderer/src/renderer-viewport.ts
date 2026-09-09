/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Camera } from './camera.js';

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
