/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capture the 3D viewport as a compressed JPEG data URL, for the Assistant
 * composer's explicit "Attach view" control only. Nothing calls this on its
 * own: a capture happens when the user clicks, and it is sent only with that
 * user's next message.
 *
 * Like the basket thumbnail (`store/basketSave.ts`), wait for submitted GPU
 * work and presented frames before sampling the WebGPU canvas, then reuse the
 * chat's compression and failure policy.
 */

import { getGlobalCanvas, getGlobalRenderer } from '@/hooks/useBCF';
import { resolveChatViewportScreenshot } from '../chat/chatViewportCapture';
import { captureCompressedCanvasImage } from '../chat/executableCodeBlockHelpers';
import { nextFrameOrTimeout } from '@/utils/frameWait';

export async function captureViewportScreenshot(): Promise<string | null> {
  const canvas = getGlobalCanvas() ?? document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
  if (!canvas) return null;
  const device = getGlobalRenderer()?.getGPUDevice();
  if (device) await device.queue.onSubmittedWorkDone();
  // Two presented frames before sampling; bounded so a hidden tab cannot strand the control (#2385).
  await nextFrameOrTimeout(250);
  await nextFrameOrTimeout(250);
  return resolveChatViewportScreenshot(canvas, captureCompressedCanvasImage);
}
