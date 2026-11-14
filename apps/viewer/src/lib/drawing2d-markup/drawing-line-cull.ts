/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which drawing lines the 2D canvas draws, by position: both ends inside the
 * drawing bounds grown by half their larger span. Lines past that are
 * generator strays and are not drawn. The canvas and the snap index share
 * this predicate, so the cursor never snaps to a line that is not drawn.
 */

import type { Drawing2D, Point2D } from '@ifc-lite/drawing-2d';

export interface LineCullBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box a line's ends must lie in to be drawn: `bounds` grown by half their larger span. */
export function lineCullBox(bounds: Drawing2D['bounds']): LineCullBox {
  const margin = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) * 0.5;
  return {
    minX: bounds.min.x - margin,
    minY: bounds.min.y - margin,
    maxX: bounds.max.x + margin,
    maxY: bounds.max.y + margin,
  };
}

/** Whether a line with these ends is drawn: both finite and inside `box`. */
export function lineInCullBox(box: LineCullBox, start: Point2D, end: Point2D): boolean {
  return start.x >= box.minX && start.x <= box.maxX && start.y >= box.minY && start.y <= box.maxY
    && end.x >= box.minX && end.x <= box.maxX && end.y >= box.minY && end.y <= box.maxY;
}
