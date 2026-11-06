/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { getDefaultEdgeLockState } from '@/store/slices/measurementSlice';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelMeasureRaycast, moveRubberBand, syncMeasureScreenCoords } from './measureHandlers.js';
import { hoverMeasurePoint } from './measurePointMode.js';
import { measureCursor } from './measureCursor.js';

/**
 * Snap turned off in the Measure tool. A queued hover or rubber-band frame
 * would re-lock the edge, so it is dropped (#8881). The live preview it would
 * have refreshed, Point mode's Live reading or the Distance rubber-band end, is
 * then re-picked once, unsnapped, where a move last drew it, through that
 * move's own pick (#8992). A pending Distance start and the gesture epoch stay.
 * With no preview following the cursor (none shown, a navigation drag, a new
 * start or a touch gesture since, a view or scene change since) nothing is
 * re-picked. A press alone moves neither the view nor the cursor, so the pick
 * under it is the one a move there would give.
 */
export function measureSnapOff(ctx: MouseHandlerContext): void {
  cancelMeasureRaycast(ctx);
  const cursor = measureCursor(ctx);
  if (!cursor) return;
  const s = useViewerStore.getState();
  const point = s.measureMode === 'point';
  if (point ? !s.measurePointLive : !s.activeMeasurement || cursor.view === null) return;
  // The animation loop's pass ends Point's Live and replaces the rubber band's noted state on any view or
  // scene change (#8886, #8998), and the canvas box watch clears that state. Run it now, as the last frame
  // saw Snap (on), so a change since that frame counts too, and the toggle itself reaches the pass only on
  // the next frame.
  syncMeasureScreenCoords({ ...ctx, snapEnabledRef: { current: true } });
  // The refs catch up with the store only on the next render: pick as Snap off does, with no lock to slide along.
  const unsnapped = { ...ctx, snapEnabledRef: { current: false }, edgeLockStateRef: { current: getDefaultEdgeLockState() } };
  if (point) {
    if (useViewerStore.getState().measurePointLive) hoverMeasurePoint(unsnapped, cursor.x, cursor.y);
  } else if (cursor.view === ctx.lastCameraStateRef.current) {
    moveRubberBand(unsnapped, cursor.x, cursor.y, cursor.orthogonal);
  }
}
