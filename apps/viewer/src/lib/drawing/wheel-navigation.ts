/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveWheelNavigation, type NavigationPreset, type WheelNavigation } from '@/lib/navigation/presets.js';
import { wheelDeltaPx } from '@/lib/navigation/wheel-input.js';

export interface DrawingViewTransform { x: number; y: number; scale: number }

/** The drawing never zooms out past this scale. */
export const MIN_DRAWING_SCALE = 0.01;

type DrawingWheelEvent = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'clientX' | 'clientY'>;

/**
 * What a wheel event over the drawing asks for (#6614): pan in CSS px and
 * whether to zoom, per the navigation preset. CSS pixels are the common frame
 * for wheel, pointer and canvas input; line and page deltas are converted
 * first (#9507). Null for non-finite input or a collapsed canvas.
 */
export function drawingWheelNavigation(
  event: DrawingWheelEvent,
  rect: Pick<DOMRect, 'width' | 'height'>,
  preset: NavigationPreset,
): WheelNavigation | null {
  if (![event.deltaX, event.deltaY, event.clientX, event.clientY, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return null;
  const deltaX = wheelDeltaPx(event.deltaX, event.deltaMode, rect.height);
  const deltaY = wheelDeltaPx(event.deltaY, event.deltaMode, rect.height);
  return resolveWheelNavigation(preset, { deltaX, deltaY, ctrlKey: event.ctrlKey || event.metaKey });
}

/** `previous` moved by `(dx, dy)` CSS px; `previous` itself when nothing usable moves. */
export function panDrawing(previous: DrawingViewTransform, dx: number, dy: number): DrawingViewTransform {
  const x = previous.x + dx;
  const y = previous.y + dy;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === previous.x && y === previous.y)) return previous;
  return { ...previous, x, y };
}

/**
 * `previous` zoomed by `factor` about canvas point `(px, py)`: the drawing
 * point under it stays under it, and the scale stops at
 * {@link MIN_DRAWING_SCALE}. `previous` itself when nothing usable changes.
 */
export function zoomDrawingAbout(previous: DrawingViewTransform, factor: number, px: number, py: number): DrawingViewTransform {
  if (![previous.x, previous.y, previous.scale, factor, px, py].every(Number.isFinite) || previous.scale <= 0) return previous;
  const scale = Math.max(MIN_DRAWING_SCALE, previous.scale * factor);
  const ratio = scale / previous.scale;
  const x = px - (px - previous.x) * ratio;
  const y = py - (py - previous.y) * ratio;
  if (![scale, x, y].every(Number.isFinite)) return previous;
  return scale === previous.scale && x === previous.x && y === previous.y ? previous : { x, y, scale };
}
