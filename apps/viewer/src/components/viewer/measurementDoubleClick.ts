/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { finishPolylineFromDoubleClick, finishRadiusFromDoubleClick } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { MIN_RADIUS_POINTS } from './tools/measure-modes/radius.js';

/** Finish the existing open polyline/radius gesture, dropping its duplicate click. */
export function handleMeasureDoubleClick(ctx: MouseHandlerContext, event: MouseEvent): void {
  if (ctx.activeToolRef.current !== 'measure') return;
  const polyline = finishPolylineFromDoubleClick();
  if (polyline !== null) {
    event.preventDefault();
    if (!polyline) import('@/components/ui/toast').then(({ toast }) => { toast.error('Polyline needs at least 2 points'); });
    return;
  }
  const radius = finishRadiusFromDoubleClick();
  if (radius === null) return;
  event.preventDefault();
  if (!radius) import('@/components/ui/toast').then(({ toast }) => { toast.error(`Radius needs at least ${MIN_RADIUS_POINTS} points`); });
}
