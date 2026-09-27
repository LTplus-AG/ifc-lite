/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Double-click closes an Add Element polygon outline (#6233), the pointer
 * twin of Enter (`addElement.commit` in useKeyboardShortcuts.ts).
 *
 * A physical double-click dispatches `click, click, dblclick`. The first
 * click places the last vertex; the second click (`detail >= 2`) lands on
 * the same spot, so it is skipped rather than appended as a duplicate
 * vertex, and the `dblclick` then closes the outline.
 */

import { useViewerStore } from '@/store';
import { commitAddElementSlabPolygon } from './selectionHandlers';

const POLYGON_TYPES = new Set(['slab', 'roof', 'plate', 'space']);

/** Whether the Add Element tool is drawing a polygon outline right now. */
function drawingAddElementPolygon(): boolean {
  const state = useViewerStore.getState();
  return state.activeTool === 'addElement'
    && POLYGON_TYPES.has(state.addElementType)
    && state.addElementSlabMode === 'polygon';
}

/** The second click of a double-click while drawing a polygon: not a new vertex. */
export function isAddElementPolygonRepeatClick(event: Pick<MouseEvent, 'detail'>): boolean {
  return event.detail >= 2 && drawingAddElementPolygon();
}

/**
 * Close the polygon being drawn. Returns false when the gesture does not
 * apply (another tool or mode, or no points placed yet) so the caller
 * leaves the DOM event alone.
 */
export function closeAddElementPolygonFromDoubleClick(): boolean {
  if (!drawingAddElementPolygon()) return false;
  if (useViewerStore.getState().addElementPendingPoints.length === 0) return false;
  commitAddElementSlabPolygon();
  return true;
}
