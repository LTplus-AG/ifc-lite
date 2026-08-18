/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2641 review defect: `hasPendingMeasurements` (Viewport.tsx) gated the
 * animation loop's per-frame `updateMeasurementScreenCoords` reprojection
 * pass on `measurements.length` / `activeMeasurement` only. With
 * polyline-only state (an in-progress click sequence, or a finished
 * polyline and nothing else) the gate returned false and the reprojection
 * pass never ran at all — so placed polyline points, segments and labels
 * froze at their click-time screen position while orbiting.
 *
 * `hasPendingMeasurementState` is the extracted, directly-testable gate
 * predicate; Viewport.tsx's `hasPendingMeasurements` calls it against the
 * live store state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasPendingMeasurementState, type PendingMeasurementState } from './viewportUtils.js';

function base(): PendingMeasurementState {
  return {
    measurements: { length: 0 },
    activeMeasurement: null,
    activePolyline: null,
    polylineMeasurements: { length: 0 },
    activeAngle: null,
    angleMeasurements: { length: 0 },
  };
}

describe('hasPendingMeasurementState — animation-loop reprojection gate', () => {
  it('is false with nothing pending', () => {
    assert.equal(hasPendingMeasurementState(base()), false);
  });

  it('is true for a drag measurement in the list (pre-existing case)', () => {
    assert.equal(hasPendingMeasurementState({ ...base(), measurements: { length: 1 } }), true);
  });

  it('is true for an in-progress drag gesture (pre-existing case)', () => {
    assert.equal(hasPendingMeasurementState({ ...base(), activeMeasurement: {} }), true);
  });

  it('is true for an in-progress POLYLINE sequence with nothing else pending', () => {
    assert.equal(hasPendingMeasurementState({ ...base(), activePolyline: { points: [{}] } }), true);
  });

  it('is true for a FINISHED polyline with nothing else pending', () => {
    assert.equal(hasPendingMeasurementState({ ...base(), polylineMeasurements: { length: 1 } }), true);
  });
});

describe('hasPendingMeasurementState — angle state (#2735)', () => {
  it('an in-progress angle sequence keeps the reprojection pass running', () => {
    // This gate and `updateMeasurementScreenCoords` are a pair: reprojection
    // written there without an arm here is dead code, and the symptom is
    // identical to having written none — placed picks freeze at their
    // click-time pixel while the model orbits. That is #2641's defect, and
    // this is its third occurrence.
    assert.equal(
      hasPendingMeasurementState({ ...base(), activeAngle: { kind: 'points', picks: [] } }),
      true,
    );
  });

  it('a finished angle measurement keeps it running too', () => {
    assert.equal(
      hasPendingMeasurementState({ ...base(), angleMeasurements: { length: 1 } }),
      true,
    );
  });
});
