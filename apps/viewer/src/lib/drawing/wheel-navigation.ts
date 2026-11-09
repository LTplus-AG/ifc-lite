/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveWheelNavigation, type NavigationPreset } from '@/lib/navigation/presets.js';
import { FINE_ZOOM_STEP_FACTOR } from '@/components/viewer/wheelZoom.js';
import { wheelDeltaPx, wheelZoomScale } from '@/lib/navigation/wheel-input.js';

export interface DrawingViewTransform { x: number; y: number; scale: number }

/** #6614: CSS pixels are the common frame for wheel, pointer and canvas input. */
export function drawingWheelTransform(
  previous: DrawingViewTransform,
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'clientX' | 'clientY'>,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  preset: NavigationPreset,
  fine: boolean,
  /** The wheel-zoom sensitivity factor (#9507). */
  sensitivity = 1,
): DrawingViewTransform {
  if (![previous.x, previous.y, previous.scale, event.deltaX, event.deltaY,
    event.clientX, event.clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || previous.scale <= 0 || rect.width <= 0 || rect.height <= 0) return previous;
  const deltaX = wheelDeltaPx(event.deltaX, event.deltaMode, rect.height);
  const deltaY = wheelDeltaPx(event.deltaY, event.deltaMode, rect.height);
  const navigation = resolveWheelNavigation(preset, { deltaX, deltaY, ctrlKey: event.ctrlKey || event.metaKey });
  const zoom = wheelZoomScale(deltaY, (fine ? FINE_ZOOM_STEP_FACTOR : 1) * sensitivity);
  const scale = navigation.zoom ? Math.max(0.01, previous.scale * zoom) : previous.scale;
  const ratio = scale / previous.scale;
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const x = pointerX - (pointerX - previous.x) * ratio + navigation.panX;
  const y = pointerY - (pointerY - previous.y) * ratio + navigation.panY;
  if (![scale, x, y].every(Number.isFinite)) return previous;
  return scale === previous.scale && x === previous.x && y === previous.y ? previous : { x, y, scale };
}
