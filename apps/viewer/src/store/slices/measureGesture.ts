/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure gesture reset (#8786), composed into the measurement slice.
 *
 * One list of what "in-progress gesture" means: each mode's sequence, the
 * Point hover, and the pick's snap target, edge lock, glyph and Shift triad,
 * which a later pick would otherwise inherit. Every reset spreads it: Esc
 * (`cancel*`), a mode or angle-kind switch, Clear all, entering or leaving the
 * tool and a model reposition (`resetMeasureGesture`). The bumped epoch tells
 * the pointer and touch handlers that a press begun before it is stale.
 */

import type { EdgeLockState } from '../types.js';

export const getDefaultEdgeLockState = (): EdgeLockState => ({
  edge: null,
  meshExpressId: null,
  edgeT: 0,
  lockStrength: 0,
  isCorner: false,
  cornerValence: 0,
});

/** The fields of a gesture reset, with the epoch bumped past `state`'s. */
export const gestureReset = (state: { measureGestureEpoch: number }) => ({
  activeMeasurement: null,
  activePolyline: null,
  activeAngle: null,
  activeRadius: null,
  measurePointLive: null, // the placed point stays readable, like the last distance
  snapTarget: null,
  snapVisualization: null,
  edgeLockState: getDefaultEdgeLockState(),
  measurementConstraintEdge: null,
  measureGestureEpoch: state.measureGestureEpoch + 1,
});
