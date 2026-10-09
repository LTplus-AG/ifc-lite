/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';
import { registerViewportCapture } from '@/lib/viewport-capture';
import { setGlobalRendererRef } from '@/hooks/useBCF';

/** GPU-free boundary for mounted download tests; real loop ownership is covered separately (#6709). */
export function installViewportCaptureBoundary(canvas: HTMLCanvasElement): () => void {
  const renderer = { render: () => {}, requestRender: () => {}, getGPUDevice: () => null } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  const unregister = registerViewportCapture(renderer, canvas, () => ({}));
  return () => { unregister(); setGlobalRendererRef({ current: null }); };
}
