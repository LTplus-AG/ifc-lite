/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveWheelNavigation, type NavigationPreset } from '@/lib/navigation/presets.js';
import { FINE_ZOOM_STEP_FACTOR } from '@/components/viewer/wheelZoom.js';

export interface DrawingViewTransform { x: number; y: number; scale: number }
const ZOOM_SENSITIVITY = Math.log(1.1) / 100;
const MAX_LOG_STEP = Math.log(1.25);

/** #6614: CSS pixels are the common frame for wheel, pointer and canvas input. */
export function drawingWheelTransform(
  previous: DrawingViewTransform,
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'clientX' | 'clientY'>,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  preset: NavigationPreset,
  fine: boolean,
): DrawingViewTransform {
  if (![previous.x, previous.y, previous.scale, event.deltaX, event.deltaY,
    event.clientX, event.clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || previous.scale <= 0 || rect.width <= 0 || rect.height <= 0) return previous;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  const deltaX = event.deltaX * unit;
  const deltaY = event.deltaY * unit;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return previous;
  const navigation = resolveWheelNavigation(preset, { deltaX, deltaY, ctrlKey: event.ctrlKey || event.metaKey });
  const exponent = Math.max(-MAX_LOG_STEP, Math.min(MAX_LOG_STEP,
    -deltaY * ZOOM_SENSITIVITY * (fine ? FINE_ZOOM_STEP_FACTOR : 1)));
  const scale = navigation.zoom ? Math.max(0.01, previous.scale * Math.exp(exponent)) : previous.scale;
  const ratio = scale / previous.scale;
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const x = pointerX - (pointerX - previous.x) * ratio + navigation.panX;
  const y = pointerY - (pointerY - previous.y) * ratio + navigation.panY;
  if (![scale, x, y].every(Number.isFinite)) return previous;
  return scale === previous.scale && x === previous.x && y === previous.y ? previous : { x, y, scale };
}
