/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { finishPolylineFromDoubleClick, finishRadiusFromDoubleClick } from './selectionHandlers.js';
import { takeDoubleClickStart } from './distanceClick.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { toastTooFewPoints } from '@/store/finishMeasureSequence';

/** Finish the existing open polyline/radius gesture, dropping its duplicate click. */
export function handleMeasureDoubleClick(ctx: MouseHandlerContext, event: MouseEvent): void {
  if (ctx.activeToolRef.current !== 'measure') return;
  // A double-click that finished a distance also pressed a fresh start: drop it (#8771).
  if (takeDoubleClickStart(ctx)) {
    useViewerStore.getState().cancelMeasurement();
    ctx.clearEdgeLock();
    return;
  }
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
