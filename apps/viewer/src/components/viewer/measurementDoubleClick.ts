/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { finishPolylineFromDoubleClick, finishRadiusFromDoubleClick } from './selectionHandlers.js';
import { takeDoubleClickStart } from './distanceClick.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { toastTooFewPoints } from '@/store/finishMeasureSequence';
import { refuseCaptureHeldPick } from '@/lib/viewport-capture';

/** Finish the existing open polyline/radius gesture, dropping its duplicate click. */
export function handleMeasureDoubleClick(ctx: MouseHandlerContext, event: MouseEvent): void {
  if (ctx.activeToolRef.current !== 'measure') return;
  // A double-click that finished a distance also pressed a fresh start: drop it (#8771).
  if (takeDoubleClickStart(ctx)) {
    useViewerStore.getState().cancelMeasurement();
    ctx.clearEdgeLock();
    return;
  }
  // Its clicks were refused, so the last point was never placed: finishing would record another shape (#9137).
  if (refuseCaptureHeldPick(ctx.renderer)) return;
  const polyline = finishPolylineFromDoubleClick();
  if (polyline !== null) {
    event.preventDefault();
    if (!polyline) toastTooFewPoints('polyline');
    return;
  }
  const radius = finishRadiusFromDoubleClick();
  if (radius === null) return;
  event.preventDefault();
  if (!radius) toastTooFewPoints('radius');
}
