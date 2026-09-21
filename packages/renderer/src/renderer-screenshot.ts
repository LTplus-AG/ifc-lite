/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebGPUDevice } from './device.js';

/** Capture a fully submitted presentation canvas, reporting expected device failures. */
export async function captureRendererScreenshot(deviceHost: WebGPUDevice, canvas: HTMLCanvasElement): Promise<string | null> {
  if (!deviceHost.isInitialized()) return null;
  try {
    await deviceHost.getDevice().queue.onSubmittedWorkDone();
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.error('[Renderer] Screenshot capture failed:', error);
    return null;
  }
}
