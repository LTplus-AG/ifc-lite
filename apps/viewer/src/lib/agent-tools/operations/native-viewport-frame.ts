/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one agent path to the rendered viewport's pixels: the canonical
 * `captureViewportFrame` on the mounted renderer (the toolbar screenshot's
 * producer). `exports.screenshot` and `viewer_screenshot` both read through
 * it; they differ only in how `read` serialises the canvas.
 */

import { getGlobalRenderer } from '@/hooks/useBCF';
import { captureViewportFrame } from '@/lib/viewport-capture';

/** No renderer is mounted (no viewport on screen, or not yet initialised). */
export const NO_NATIVE_RENDERER = 'Native viewport renderer is not ready.';

/**
 * Render one owned frame and serialise it with `read`, which must copy the
 * pixels synchronously (WebGPU discards the canvas after presentation).
 * Throws when no renderer is mounted; resolves null when the capture failed.
 */
export async function captureNativeViewport(read: (canvas: HTMLCanvasElement) => string): Promise<string | null> {
  const renderer = getGlobalRenderer();
  if (!renderer) throw new Error(NO_NATIVE_RENDERER);
  return captureViewportFrame(renderer, { read });
}
