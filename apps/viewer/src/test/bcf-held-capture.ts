/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A BCF viewpoint capture the test can hold open (C-2). The real
 * `createViewpointFromState` → `captureViewportFrame` path runs against a
 * registered canonical viewport; only the renderer's GPU completion is a
 * promise the test settles, so the test decides when each capture lands.
 */

import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { clearGlobalRefs, setGlobalCanvasRef, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { registerViewportCapture } from '@/lib/viewport-capture';
import { waitFor } from './render.js';

export interface HeldCapture {
  /** Frames rendered so far: one per viewpoint capture that reached the viewport. */
  frames(): number;
  /** Wait for capture `n` (1-based) to reach GPU completion, then let it finish. */
  release(n: number): Promise<void>;
  /** Wait for capture `n` to reach GPU completion, then fail it (the frame is lost). */
  fail(n: number): Promise<void>;
  /** Stop holding: pending and later captures complete immediately. */
  releaseAll(): void;
  /** After this, reading the camera throws, so a capture whose frame was lost rejects. */
  breakCamera(): void;
  /** Unplug the viewport: later captures resolve `null` (no renderer, no camera). */
  unplug(): void;
  dispose(): void;
}

export function installHeldCapture(): HeldCapture {
  const gates: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let hold = true;
  let frames = 0;
  let cameraBroken = false;
  const camera = {
    getPosition: () => ({ x: 10, y: 5, z: 20 }), getTarget: () => ({ x: 1, y: 2, z: 3 }), getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4, getProjectionMode: () => 'perspective', getOrthoSize: () => 10, getAspect: () => 16 / 9, getDistance: () => 10,
  };
  const renderer = {
    renderWithResult: () => true,
    requestRender: () => {},
    getGPUDevice: () => ({ queue: { onSubmittedWorkDone: () => hold
      ? new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }); })
      : Promise.resolve() } }),
    getCamera: () => {
      if (cameraBroken) throw new Error('camera unavailable');
      return camera;
    },
  } as unknown as Renderer;
  const canvas = document.createElement('canvas');
  canvas.toDataURL = () => `data:image/png;base64,frame-${++frames}`;
  document.body.appendChild(canvas);
  setGlobalRendererRef({ current: renderer });
  setGlobalCanvasRef({ current: canvas });
  const unregister = registerViewportCapture(renderer, canvas, () => ({}));
  const settle = async (n: number, how: 'resolve' | 'reject') => {
    await waitFor(() => gates.length >= n, `capture ${n} reached GPU completion`);
    await act(async () => {
      if (how === 'resolve') gates[n - 1].resolve();
      else gates[n - 1].reject(new Error('frame lost'));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  };
  return {
    frames: () => frames,
    release: n => settle(n, 'resolve'),
    fail: n => settle(n, 'reject'),
    releaseAll: () => { hold = false; for (const gate of gates) gate.resolve(); },
    breakCamera: () => { cameraBroken = true; },
    unplug: () => { unregister(); clearGlobalRefs(); },
    dispose: () => { unregister(); clearGlobalRefs(); canvas.remove(); },
  };
}
