/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import { measureCanvasBoxWatch, type MeasureCameraState } from './measureCameraState';

/**
 * The viewport canvas's ResizeObserver. Each report re-renders (the frame
 * re-sizes the drawing buffer itself), and its CSS box also ends Point mode's
 * Live on any resize (#8886). Kept out of Viewport.tsx so the wiring has a test
 * (#9002).
 */
export function observeViewportCanvas(
  canvas: HTMLCanvasElement,
  lastCameraStateRef: MutableRefObject<MeasureCameraState | null>,
  onResize: () => void,
): ResizeObserver {
  const noteCanvasBox = measureCanvasBoxWatch(lastCameraStateRef);
  const observer = new ResizeObserver((entries) => {
    noteCanvasBox(entries);
    onResize();
  });
  // The device-pixel box also fires when only the pixel ratio changes (window
  // moved to another display, browser zoom), which the CSS box does not.
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch (err) {
    console.debug('[Viewport] device-pixel-content-box unsupported; observing the CSS box', err);
    observer.observe(canvas);
  }
  return observer;
}
